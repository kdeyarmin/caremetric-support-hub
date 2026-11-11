# Connect Google Search Console

Brave Search discovers public organizations and pages. Google Search Console reports how the verified CareMetric websites perform in Google. They are separate connections.

1. In [Google Cloud](https://console.cloud.google.com/), select or create a CareMetric project. Enable the [Google Search Console API](https://console.cloud.google.com/apis/library/searchconsole.googleapis.com).
2. Open **IAM & Admin → Service Accounts** and create `caremetric-marketing`. No Google Cloud project role is needed for this read-only connection. Copy its email address.
3. In [Search Console](https://search.google.com/search-console), open the verified Intel website property. Under **Settings → Users and permissions**, add the service account email with **Restricted** access. If the website has no verified property, verify ownership first using Google's instructions. A domain property covers all subdomains; a URL-prefix property must match the website prefix exactly.
4. In Google Cloud, open that service account → **Keys → Add key → Create new key → JSON**. Keep the downloaded private key out of chat, source control and support messages. If Google blocks key creation, follow the organization-policy guidance below before continuing.
5. Add the complete JSON as the secret `HUB_SEARCH_CONSOLE_CREDENTIALS` on the **support-hub-web** Railway service. Keep secrets in Railway; the property names belong in the Hub. Include the secret in the next normal reviewed release rather than starting an unrelated deployment.
6. In the Hub, open **Settings → Search → Search Console properties**. Paste the property name exactly as Google shows it, for example `sc-domain:caremetricintel.com` for a domain property or `https://www.caremetricintel.com/` for a URL-prefix property. Add only properties that have granted this service account access.
7. On the AI team page, use **Run now → Weekly SEO check**. Confirm the report reads the intended property successfully. The toolkit's configured indicator validates local setup; the report confirms actual Google access. New properties can have little or no historical data.

The Hub requests only the `webmasters.readonly` scope. It uses pinned Google endpoints and does not log or display the private key. The public-site crawl continues to work if Search Console is unavailable.

If verification requires a website HTML tag or file, use the exact verification value provided by Google. The Intel site supports a public Google verification tag through its existing website configuration. Domain verification uses a DNS record at the domain's DNS provider.

## When Google blocks key creation

In **IAM & Admin → Organization policies**, inspect the effective policy and inheritance for both `iam.disableServiceAccountKeyCreation` (legacy) and `iam.managed.disableServiceAccountKeyCreation` (managed). Google evaluates both constraints when both are active; changing one does not disable the other. A generic key-security warning is not proof that a policy blocks creation: confirm the actual error and effective policy.

Ask the organization's policy administrator for an approved connection method. Being a project owner does not necessarily grant permission to manage an inherited organization policy. See Google's [policy troubleshooting guide](https://docs.cloud.google.com/iam/docs/troubleshoot-org-policies) and [constraint reference](https://docs.cloud.google.com/organization-policy/reference/org-policy-constraints).

If the administrator approves a temporary exception, record the original policy source, rules and inheritance first. Use the narrowest supported scope and preserve unrelated rules. A project-wide exception removes these policy restrictions for every service account in that project while it is active; IAM permissions still apply. Create only the intended reader key, transfer its complete JSON directly to the Hub's private secret, then restore the original restrictions and confirm both effective policies. Do not broaden the exception if a step fails; restore the original policy and report the blocker.

Saving the credential does not require an ad hoc deployment. Include it in the next reviewed main-branch release, then use **Weekly SEO check** to verify access. Keep the website verification token deployed: restoring key-creation restrictions does not replace Google's ongoing ownership check.
