PennSync connects to the Hub for support, guidance and personal training records.
It does not accept payments. No PennSync role can purchase subscriptions, start
payment trials, authorize charges or open a payment portal through this connection.

`guides.json` is the maintained input for the original `self-service.v1` release.
Its generated migration is immutable after release. The forward migration
`20261028181036_exclude_pennsync_from_payments.sql` retires PennSync's subscription
guide publication; search, AI retrieval and printable manuals use those published
scopes. Keep this exclusion when publishing future guidance revisions. Existing
training and support publications remain available.
