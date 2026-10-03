# bscan fingerprint branding

The app uses the selected Wallet Fingerprint logo and white bscan wordmark.

- `bscan-option-4-wallet-fingerprint.png`: original horizontal logo reference.
- `x/wallet-fingerprint-x-profile.png`: original fingerprint reference used for icon exports.
- `x/wallet-fingerprint-x-header.png`: original X header reference.
- `x/wallet-fingerprint-x-profile-black.png` and `x/wallet-fingerprint-x-header-black.png`: X assets with verified RGB (0, 0, 0) background regions.
- `x/black-background-prompts.md`: built-in imagegen edit prompts and PNG export notes.

Run `node scripts/export-fingerprint-brand.mjs` to reproduce the production assets in `public/`.
The app lockup has an approximately 8px optical gap at its desktop header size.
The favicon has a transparent background and a larger, centered fingerprint with 4px vertical padding on a 128px canvas.
Its SVG alpha mask removes the original charcoal background while preserving the exact selected ridge shapes. Both SVG and PNG favicon formats are exported.

An imagegen background-extraction attempt was rejected because it introduced artifacts in the gaps. The final favicon uses the original reference through the SVG alpha mask instead of the altered image.
