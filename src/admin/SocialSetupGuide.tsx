import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { Copy, ExternalLink } from "lucide-react";
import type { SocialProvider } from "./socialConnectionsClient";

function SetupAddress({ label, href }: { label: string; href: string }) {
  const [message, setMessage] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(href);
      setMessage("Address copied. Paste it into Edge, Chrome or Safari.");
    } catch { setMessage("Copy is unavailable. Select the address below and copy it manually."); }
  }
  return <div className="social-setup-address">
    <div className="button-row">
      <a href={href} target="_blank" rel="noreferrer">{label} <ExternalLink size={13} aria-hidden="true" /></a>
      <button type="button" className="button button-secondary button-small" aria-label={`Copy ${label} address`} onClick={() => void copy()}><Copy size={13} aria-hidden="true" /> Copy address</button>
    </div>
    <code>{href}</code>
    {message && <small role="status">{message}</small>}
  </div>;
}

type Step = { title: string; body: ReactNode };
const linkedinSteps: Step[] = [
  { title: "Sign in and open the developer site", body: <>
    <p>Open Edge, Chrome or Safari directly. Sign in to LinkedIn with the personal account that manages your Company Page. Then open the developer site in that same browser and choose <strong>My apps</strong>.</p>
    <SetupAddress label="LinkedIn sign-in" href="https://www.linkedin.com/" />
    <SetupAddress label="LinkedIn developer site" href="https://developer.linkedin.com/" />
    <p className="muted">Use Copy address if a link opens inside another app or shows “page not found.” Your email and password belong on LinkedIn’s sign-in screen.</p>
  </> },
  { title: "Create the app and verify its Company Page", body: <>
    <p>In <strong>My apps</strong>, select your app for this Company Page, or choose <strong>Create app</strong>. For a new app, enter an app name, select your Company Page, and supply your published privacy policy URL and logo.</p>
    <p>Open the app’s <strong>Settings</strong> tab. Choose <strong>Verify → Generate URL</strong>. Open that verification address while signed in as the Page’s <strong>super admin</strong> and approve the association.</p>
    <p className="muted">Check that the app’s Settings now shows the Page association as verified. Creating an app alone does not grant publishing access.</p>
    <a href="https://www.linkedin.com/help/linkedin/answer/a1665329" target="_blank" rel="noreferrer">LinkedIn’s app verification instructions</a>
  </> },
  { title: "Request access to manage Company Page content", body: <>
    <p>In the app’s <strong>Products</strong> tab, find <strong>Community Management API</strong> and choose <strong>Request access</strong>. Complete LinkedIn’s application using your legal business details, business email, website and privacy policy.</p>
    <p><strong>Wait for LinkedIn to approve access before generating the Page token.</strong> If the product is unavailable because the app already has another product, LinkedIn directs applicants to use a new app for Community Management.</p>
    <p className="muted">Sign In with LinkedIn and Share on LinkedIn alone do not provide this Company Page integration. Development tier supports initial testing; this Hub’s full engagement reporting needs Standard tier access.</p>
    <a href="https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-api-migration-guide" target="_blank" rel="noreferrer">LinkedIn’s approval requirements and tiers</a>
  </> },
  { title: "Generate your LinkedIn access token", body: <>
    <p>Open the separate <strong>OAuth Token Tools</strong> page below. In its token generator, select your approved app and the member authorization flow (<strong>3-legged OAuth</strong>).</p>
    <SetupAddress label="LinkedIn OAuth Token Tools" href="https://www.linkedin.com/developers/tools/oauth" />
    <p>Select these permissions for the Hub’s Page posts and comments:</p>
    <ul className="social-permissions"><li><code>r_organization_social</code> — read Page posts</li><li><code>w_organization_social</code> — publish Page posts</li><li><code>r_organization_social_feed</code> — read engagement and comments</li><li><code>w_organization_social_feed</code> — reply and moderate comments</li></ul>
    <p>Authorize as a Page administrator, then choose <strong>Copy token</strong> on the token details screen. Note its expiry date. If these permissions are missing, return to Products and check the app’s approval.</p>
  </> },
  { title: "Enter the Page ID and token in the Hub", body: <>
    <p>Open your Company Page in admin view. An address such as <code>linkedin.com/company/123456/admin/</code> contains the Page ID <strong>123456</strong>. Copy your own numeric ID or the full admin address into <strong>LinkedIn Company Page ID</strong> below.</p>
    <p>Paste the value from <strong>Copy token</strong> into <strong>LinkedIn access token</strong>, then choose <strong>Save and check</strong>. The app’s client ID, client secret and your password are different values.</p>
    <p className="muted">A successful check confirms read access only. Publishing is not tested, and the AI team’s approval settings still apply. Leave renewal and advertising fields empty for an initial Page connection.</p>
  </> },
];

const metaSteps: Step[] = [
  { title: "Find your business portfolio and Facebook Page", body: <>
    <p>Open Meta Business Suite in your normal browser. Choose the business portfolio that manages your Facebook Page, then open <strong>Settings → Accounts → Pages</strong>. Select the Page and copy its numeric <strong>Page ID</strong>.</p>
    <SetupAddress label="Meta Business Suite settings" href="https://business.facebook.com/settings/" />
    <p className="muted">You need permission to manage the portfolio and Page. If the Page is missing, resolve its access in Business Suite before continuing. Start with Facebook; Instagram and advertising can be added afterward.</p>
  </> },
  { title: "Set up the Meta developer app", body: <>
    <p>Open Meta’s app dashboard. Select your app, or choose <strong>Create app</strong> and the <strong>Manage everything on your Page</strong> use case. Associate the app with the same business portfolio as your Page.</p>
    <SetupAddress label="Meta app dashboard" href="https://developers.facebook.com/apps/" />
    <p>Customize that use case with the permissions listed in step 4. Complete the app review, business verification and access requirements Meta shows for those permissions and system-user tokens.</p>
    <p className="muted">If your dashboard differs or a permission is unavailable, use Meta’s current guide below. Creating the app does not automatically approve its permissions.</p>
    <a href="https://developers.facebook.com/documentation/pages-api/create-an-app" target="_blank" rel="noreferrer">Meta’s Pages app setup guide</a>
  </> },
  { title: "Assign the app and Page to a system user", body: <>
    <p>Return to <strong>Meta Business Suite → Settings → Users → System users</strong>. Choose <strong>Add new system user</strong>, give it a name such as <strong>CareMetric Hub</strong>, and create it. If asked for a role, use a regular/employee system user for asset access.</p>
    <p>Assign the <strong>Facebook Page</strong> with the tasks needed for content and engagement, and assign the <strong>developer app</strong> with permission to manage that app. Both the app and system user must belong to this business portfolio.</p>
    <p className="muted">System users are not available to every business. If this menu or your app is missing, check the portfolio’s app ownership and eligibility before continuing.</p>
    <a href="https://www.facebook.com/business/help/503306463479099" target="_blank" rel="noreferrer">Meta’s system user instructions</a>
  </> },
  { title: "Generate the system user access token", body: <>
    <p>Select the system user and choose <strong>Generate new token</strong>. Select your app, choose an available expiration, and select these permissions for Facebook posts and comments:</p>
    <ul className="social-permissions"><li><code>business_management</code></li><li><code>pages_show_list</code></li><li><code>pages_read_engagement</code></li><li><code>pages_read_user_content</code></li><li><code>pages_manage_posts</code></li><li><code>pages_manage_engagement</code></li></ul>
    <p>Add <code>pages_messaging</code> only if you will use Messenger replies. Choose <strong>Generate token</strong>, then copy the token. If permissions are missing, check the app assignment and the app’s permission approval first.</p>
    <p className="muted">Note the expiry date. The Hub does not renew Meta tokens automatically; replace an expiring token before that date. Never paste your Facebook password into the Hub.</p>
  </> },
  { title: "Save and check Facebook access", body: <>
    <p>Enter the number from step 1 in <strong>Facebook Page ID</strong>. Paste the generated token from step 4 into <strong>Meta system user access token</strong>, then choose <strong>Save and check</strong>.</p>
    <p>Leave Instagram and advertising fields empty for this first check. Add those accounts afterward using their optional sections below.</p>
    <p className="muted">A successful check confirms read access only. Publishing is not tested, and connecting an account does not resume the AI agent or change its approval settings.</p>
  </> },
];

export function SocialSetupGuide({ provider, onEnterDetails }: { provider: SocialProvider; onEnterDetails: () => void }) {
  const [step, setStep] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const steps = provider === "meta" ? metaSteps : linkedinSteps;
  const name = provider === "meta" ? "Meta" : "LinkedIn";
  const current = steps[step];
  function move(next: number) { setStep(next); heading.current?.focus(); }
  return <details className="social-setup-guide" open>
    <summary>{name} setup instructions</summary>
    <div className="social-setup-content">
      <p className="muted">Follow these instructions on {name}, then enter the two connection values below. Moving through this guide does not connect an account.</p>
      <p className="social-setup-progress" role="status">Step {step + 1} of {steps.length}</p>
      <h4 ref={heading} tabIndex={-1}>{current.title}</h4>
      <div className="social-setup-step" key={step}>{current.body}</div>
      <div className="button-row">
        <button type="button" className="button button-secondary" disabled={step === 0} onClick={() => move(step - 1)}>Previous step</button>
        {step < steps.length - 1
          ? <button type="button" className="button button-secondary" onClick={() => move(step + 1)}>Next step</button>
          : <button type="button" className="button button-secondary" onClick={onEnterDetails}>Enter connection details</button>}
      </div>
      <button type="button" className="button button-secondary button-small" onClick={onEnterDetails}>I already have a Page ID and token</button>
      <details className="social-setup-trouble"><summary>Sign-in or verification trouble?</summary>
        <p>Copy the address and paste it into a separate Edge, Chrome or Safari window. Sign in there first. If picture verification keeps failing, use an audio or accessibility option if offered, or the provider’s sign-in help. The Hub cannot complete that verification.</p>
        <a href={provider === "meta" ? "https://www.facebook.com/help/" : "https://www.linkedin.com/help/linkedin"} target="_blank" rel="noreferrer">{name} sign-in help</a>
      </details>
    </div>
  </details>;
}
