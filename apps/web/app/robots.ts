import type { MetadataRoute } from 'next'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/' },
    sitemap: 'https://quorvel.tech/sitemap.xml',
    host: 'https://quorvel.tech',
  }
}
