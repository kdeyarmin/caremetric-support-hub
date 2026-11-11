# Connect Google Search Console

Brave Search discovers public organizations and pages. Google Search Console reports how the verified CareMetric websites perform in Google. They are separate connections.

1. In [Google Cloud](https://console.cloud.google.com/), select or create a CareMetric project. Enable the [Google Search Console API](https://console.cloud.google.com/apis/library/searchconsole.googleapis.com).
2. Open **IAM & Admin → Service Accounts** and create `caremetric-marketing`. No Google Cloud project role is needed for this read-only connection. Copy its email address.
3. In [Search Console](https://search.google.com/search-console), open the verified Intel website property. Under **Settings → Users and permissions**, add the service account email with **Restricted** access. If the website has no verified property, verify ownership first using Google's instructions. A domain property covers all subdomains; a URL-prefix property must match the website prefix exactly.
4. In Google Cloud, open that service account → **Keys → Add key → Create new key → JSON**. Keep the downloaded private key out of chat, source control and support messages. If the organization's policy disables key creation, ask its administrator for an approved connection method; do not work around that policy.
5. Add the complete JSON as the secret `HUB_SEARCH_CONSOLE_CREDENTIALS` on the **support-hub-web** Railway service. Keep secrets in Railway; the property names belong in the Hub. Include the secret in the next normal reviewed release rather than starting an unrelated deployment.
6. In the Hub, open **Settings → Search → Search Console properties**. Paste the property name exactly as Google shows it, for example `sc-domain:caremetricintel.com` for a domain property or `https://www.caremetricintel.com/` for a URL-prefix property. Add only properties that have granted this service account access.
7. On the AI team page, use **Run now → Weekly SEO check**. Confirm the report reads the intended property successfully. The toolkit's configured indicator validates local setup; the report confirms actual Google access. New properties can have little or no historical data.

The Hub requests only the `webmasters.readonly` scope. It uses pinned Google endpoints and does not log or display the private key. The public-site crawl continues to work if Search Console is unavailable.

If verification requires a website HTML tag or file, use the exact verification value provided by Google. The Intel site supports a public Google verification tag through its existing website configuration. Domain verification uses a DNS record at the domain's DNS provider.
