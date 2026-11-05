# Owner-directed email

The AI Team screen lets the owner prepare a one-off operational email, such as a vendor support
request, and approve its exact contents for sending through the Hub's configured email service.

## Using it

1. Sign in to the private Hub with the registered owner's SMS session and open **AI team**.
2. Enter one recipient address, a subject, and the message in the owner email composer.
3. Prepare the email. This creates a proposal under the Chief of Staff; it sends nothing.
4. Review the exact **To**, **Subject**, and message in **Waiting for you**.
5. Use **Approve and send**, or reject the proposal. The approval note is audit context; it does
   not change the message.

After a proposal is rejected or expires, **Prepare a fresh proposal** requests a fresh review of
the same draft. This option is offered only after the server confirms one of those unsent
states. An unchanged draft keeps its request key through a lost response or an uncertain send.

The subject can contain up to 200 characters and the message up to 5,000. Recipient and subject
controls reject header injection and multiple recipients. The Hub preserves the approved text
without a customer campaign footer or a model rewrite. No message content is sent to an AI model.

## Sending outcomes

The Hub records a send attempt before contacting the email provider. A successful response means
the provider **accepted** the message; it is not proof of delivery to the recipient's inbox.
Provider refusal and an uncertain outcome are shown separately. A timeout, disconnected response,
or crash after the send started does not make the message safe to send again. The Hub does not
automatically resend that action. Check the provider's activity before deciding on any new message.

If a server interruption leaves an approved email waiting, **Run what's waiting** can resume it
while the owner is signed in, including when the scheduler is off. Recovery checks the same
private send record. An unfinished earlier attempt is reported as uncertain; an email whose
send never started can proceed under the existing approval. A running execution must become
stale before recovery can take it over.

Preparing the same draft again with its request key returns the original proposal. Reusing that
key with different contents is refused. A repeated approval or competing worker cannot claim a
second send for the same action. The browser retains only a draft fingerprint and request key for
retry recovery, not the recipient or message text in session storage.

## Access and records

The owner command uses the Hub's existing administrator SMS session and command authorization.
The recipient, subject, and body remain in private records and the owner's preview. Audit events
and execution logs carry identifiers and outcome codes, without the message text. The new action
cannot be created by a model recommendation or approved by an agent's autonomy settings.

The existing sender identity and mail service configuration are reused. This feature does not
enable a new agent, alter its budget, or add automatic customer outreach.

## Deployment

Apply the reviewed `agent_external_email` migration and its contract migration before deploying
the application change. The contract declares `platform.agents.external-email.v1`. The composer
is enabled only when that feature and the existing email transport are ready.

The pull-request checks run the external email PostgreSQL integration test twice, alongside the
existing application, lifecycle-email, communications, and database security checks. The new
tests cover owner authorization, immutable approvals, duplicate request keys, execution fencing,
provider outcomes, and the durable no-resend boundary.
