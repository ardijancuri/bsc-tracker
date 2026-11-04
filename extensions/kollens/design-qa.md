# Wallets popup design QA

Compared the supplied Chrome popup with the 360 × 600 signed-out Wallets view captured in isolated Chromium. The comparison used the content region inside the popup and excluded browser chrome. The local captures are `.cache/extension/qa/wallets-popup.png` and `.cache/extension/qa/wallets-comparison.png`.

- The compact header, BNB badge, balance card, wallet action and onboarding card follow the reference layout. The bottom bar stays fixed with four equally spaced icons and a clear selected state.
- Inter and the Kollens logo, colors and BNB asset match the rest of the extension. The balance shows native BNB. The onboarding card uses the extension's create and import actions.
- Wallet creation, import and password-protected backup worked in the actual unpacked Chrome extension. Profile, Settings and Tokens opened from the bottom bar. The local browser preview shows the layout with wallet actions disabled.
- The first pass caught an inherited rule that hid the Settings content and the missing wallet action above the onboarding card. The revised capture and navigation test passed.

final result: passed
