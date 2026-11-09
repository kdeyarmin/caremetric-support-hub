# Brand assets the Creative Director renders with

Copies of each product's official brand files, served by the product's own site. They are bundled so rendering needs no network and
every render uses the same files. `themes.mjs` lists them, and `themes.test.mjs` holds each to its size.

| File | Source | Used for |
| --- | --- | --- |
| `caremetric-intel-logo-reverse.png` (228×190) | https://caremetricintel.com/brand/caremetric-logo-reverse.png | CareMetric Intel's mark on its dark Emberline canvas |
| `emberline-fire.png` (1200×200) | https://caremetricintel.com/brand/emberline-fire.png | The Emberline fire band along the bottom of Intel creative and its video end card |
| `carebase-lockup.png` (480×121) | https://cmcarebase.com/brand/email-lockup-carebase.png | CareMetric CareBase's logo lockup on white |

These are the same files the products' own emails show (`server/email-layout.mjs`). When a product changes its brand files, download the
new ones over these (same names), check the sizes in `themes.mjs` and `themes.test.mjs`, and commit. A logo the owner uploads to a
product's brand kit on the Creative screen is used instead of the bundled one.
