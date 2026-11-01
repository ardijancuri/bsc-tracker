# v1.5 replay motion update

Trade replays keep the line chart, 8–25 second duration, existing encoding and
frozen financial ending. The chart pans and gradually fits its revealed history;
buy/sell amounts rise and fade above their execution with consistent sizing.
The big-sell highlight, zoom and slow-motion treatment are removed.

The visual opening starts at the first recorded buy. Earlier transfers and sales
remain in accounting. Long histories with a dense opening reserve a small 3.5%
share of horizontal story space, blended monotonically into the remaining
chronological chart. The regular camera stays in place and timestamps remain
authentic. Short histories keep their existing horizontal geometry.

Offscreen video encoding leaves the share preview paused at its first buy.
Image export captures the ending result without moving that preview. The first
frame no longer leaks a future steep stroke through the chart clip.

Local validation covers deterministic seeking, dense/same-second movements,
smooth opening-to-history transitions, frozen profit/ROI, encoding and session
cancellation. Actual 10, 12.5 and 25 second MP4 examples were generated and
inspected. Backend source, financial policy, database schema and X publishing
configuration are unchanged by this release.
