import {env} from 'node:process'
import {formatISO} from 'date-fns'
import {type ModelDefinition, NetlifyIntegration} from '@netlify/sdk'
import type {SourceNodesArgs} from '@netlify/content-engine'
import wretch from 'wretch'
import 'dotenv/config'
async function syncArticles(apiToken : string, model : ModelDefinition['dataAPI'], cache : SourceNodesArgs['cache'], updatedGte : null | string = null) {
  interface PreprArticlesRes {
    data : {
      Articles : {
        items : Array<{
          _changed_on : string
          _id : string
          _slug : string
          authors : Array<{
            _changed_on : string
            _id : string
            bio : string
            full_name : string
          }>
          categories : Array<{
            _changed_on : string
            _id : string
            _slug : string
            title : string
          }>
          content : Array<{
            items : Array<{
              _id : string
              _type : string
              url : string
            }>
          } | {
            _id : string
            code : string
            language : 'JS' | 'TS' | 'RB'
          } | {
            _id : string
            format : 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6' | null
          }>
          title : string
        }>
        total : number
      }
    }
  }
  const allArticles : PreprArticlesRes = {
    data: {
      Articles: {
        items: [],
        total: 0
      }
    }
  }
  async function fetchArticles(skip : number = 0) {
    const articlesInPage = await wretch('https://graphql.prepr.io/').post({
      query: `query (
        $skip: Int
        $where: ArticleWhereInput
      ) {
        Articles (
          limit: 100
          skip: $skip,
          sort: changed_on_DESC,
          where: $where
        ) {
          items {
            _changed_on,
            _id,
            _slug,
            authors {
              _id,
              _changed_on,
              bio,
              full_name
            },
            categories {
              _changed_on,
              _id,
              _slug,
              title
            },
            content {
              ... on Assets {
                items {
                  _id,
                  _type,
                  url
                }
              },
              ... on CodeBlock {
                _id,
                code,
                language
              },
              ... on Text {
                _id,
                html
              }
            }
            title
          },
          total
        }
      }`,
      variables: {
        skip,
        where: {
          _changed_on_gte: updatedGte
        }
      }
    } satisfies {
      operationName? : string
      query : string
      variables? : Record<string, number | Record<string, null | string>>
    }, apiToken).json<PreprArticlesRes | {
      errors : Array<{
        extensions : {
          category : 'graphql'
        }
        locations : Array<{
          column : number
          line : number
        }>
        message : string
      }>
    }>()
    if ('errors' in articlesInPage) {
      throw new Error(articlesInPage.errors.reduce((currentString, currentError, currentErrorIndex) => {
        return `${currentString}GraphQlError ${currentErrorIndex + 1}: ${currentError.message} at ${currentError.locations[0].line}:${currentError.locations[0].column}\n`
      }, `Received ${articlesInPage.errors.length} error(s) from GraphQL:\n`))
    } else {
      allArticles.data.Articles.items = allArticles.data.Articles.items.concat(articlesInPage.data.Articles.items)
      if (allArticles.data.Articles.total === 0) {
        allArticles.data.Articles.total = articlesInPage.data.Articles.total
      }
      if (allArticles.data.Articles.total > allArticles.data.Articles.items.length) {
        await fetchArticles(skip + 100)
      }
    }
  }
  await fetchArticles()
  model.create(allArticles.data.Articles.items.map(article => {
    return {
      authors: article.authors.map(author => {
        return {
          author_id: author._id,
          bio: author.bio,
          name: author.full_name
        }
      }),
      body: article.content.reduce((body, content) => {
        if ('items' in content) {
          return content.items.reduce((contentBody, contentItem) => {
            return `${contentBody}<img href="${contentItem.url}"/>`
          }, '')
        } else if ('code' in content) {
          return `${body}<pre lang=${content.language.toLowerCase()}><code>${content.code}</code></pre>`
        } else if ('html' in content) {
          return `${body}${content.html}`
        } else {
          return body
        }
      }, ''),
      categories: article.categories.map(category => {
        return {
          category_id: category._id,
          slug: category._slug,
          title: category.title
        }
      }),
      id: article._id,
      slug: article._slug,
      title: article.title,
      updated: article._changed_on
    }
  }))
  await cache.set('lastSync', formatISO(Date.now()))
}
export const integration = new NetlifyIntegration()
const integrationConnector = integration.addConnector({
  localDevOptions: {
    apiToken: env['PREPR_TOKEN']!
  },
  typePrefix: 'Prepr'
})
integrationConnector.defineOptions(defineOptionsApi => {
  return defineOptionsApi.zod.object({
    apiToken: defineOptionsApi.zod.string().meta({
      helpText: 'Prepr API token, found here: https://[prepr-environment].prepr.io/settings/access-tokens',
      label: 'API token',
      secret: true
    })
  })
})
integrationConnector.event('createAllNodes', async (createAllNodesApi, configOptions) => {
  await syncArticles(configOptions.apiToken as string, createAllNodesApi.models.Article, createAllNodesApi.cache, null)
})
integrationConnector.event('updateNodes', async (updateNodesApi, configOptions) => {
  if (updateNodesApi.webhookBody.event === 'content_item.deleted') {
    updateNodesApi.models.Article.delete(updateNodesApi.webhookBody.payload.id)
  } else {
    const lastSync = await updateNodesApi.cache.get('lastSync')
    await syncArticles(configOptions.apiToken as string, updateNodesApi.models.Article, updateNodesApi.cache, lastSync)
  }
})
integrationConnector.model(async modeler => {
  modeler.define.nodeModel({
    cacheFieldName: 'updated',
    fields: {
      authors: {
        list: true,
        type: modeler.define.inlineObject({
          fields: {
            author_id: {
              required: true,
              type: 'String'
            },
            bio: {
              type: 'String'
            },
            name: {
              required: true,
              type: 'String'
            }
          }
        })
      },
      body: {
        required: true,
        type: 'String'
      },
      categories: {
        list: true,
        type: modeler.define.inlineObject({
          fields: {
            category_id: {
              required: true,
              type: 'String'
            },
            slug: {
              required: true,
              type: 'String'
            },
            title: {
              required: true,
              type: 'String'
            }
          }
        })
      },
      slug: {
        required: true,
        type: 'String'
      },
      title: {
        required: true,
        type: 'String'
      },
      updated: {
        required: true,
        type: 'String'
      }
    },
    name: 'Article'
  })
})