export interface GuideSection {
  id: string;
  title: string;
  paragraphs?: string[];
  steps?: string[];
  bullets?: string[];
  note?: { title: string; text: string };
  image?: { file: string; alt: string; caption: string; width: number; height: number };
}

export interface GuideTopic {
  id: string;
  label: string;
  intro: string;
  sections: GuideSection[];
}

export const guideTopics: GuideTopic[] = [
  {
    id: 'start',
    label: 'Start here',
    intro: 'Find related BNB Chain tokens on GMGN, see what tracked traders are buying and selling on X, and manage wallets from Chrome.',
    sections: [
      {
        id: 'install',
        title: 'Install in desktop Chrome',
        steps: [
          'Download the Companion ZIP from this page and extract it to a folder you can keep. Use Chrome 127 or newer.',
          'Open chrome://extensions in Chrome and turn on Developer mode.',
          'Choose Load unpacked and select the extracted folder containing manifest.json.',
          'Open Chrome’s Extensions menu and pin Kollens Companion so you can open it from the toolbar.',
        ],
      },
      {
        id: 'update',
        title: 'Update an existing installation',
        steps: [
          'Download the latest ZIP and extract its files into the folder your existing Companion installation uses.',
          'Open chrome://extensions and click Reload on the Kollens Companion card.',
          'Refresh any GMGN or X tab you already had open.',
        ],
        note: { title: 'Keep the existing installation', text: 'Reloading the same unpacked extension keeps its local data. Back up any wallet keys before removing the extension, clearing its data, or switching Chrome profiles.' },
      },
      {
        id: 'workspace',
        title: 'Open your workspace',
        paragraphs: [
          'Open Companion from the Chrome toolbar. The bottom bar switches between Wallets, Tokens, Settings and Profile. The Open side panel icon keeps the same workspace visible beside your tab.',
          'In Tokens, use Matches to compare token groups, Saved for your favorites and notes, and Activity to review match alerts.',
        ],
      },
    ],
  },
  {
    id: 'account',
    label: 'Account & sync',
    intro: 'Sign in to sync your saved tokens, private notes and preferences across Chrome profiles.',
    sections: [
      {
        id: 'sign-in',
        title: 'Sign in from Profile',
        steps: [
          'Open Profile and select Continue with Google.',
          'Complete sign-in in the Chrome authorization window. Reopen Companion to see your account.',
        ],
        image: { file: 'signin.webp', alt: 'Companion Account sign-in screen with the Continue with Google button', caption: 'Google sign-in in the public build.', width: 720, height: 580 },
      },
      {
        id: 'email',
        title: 'Use an email code where available',
        paragraphs: ['When Continue with email is available, enter your email address, select Send code and enter the six-digit code in Companion.'],
        image: { file: 'email-code.webp', alt: 'Companion email sign-in with a verification code field and a demo email address', caption: 'Demo email verification screen. Availability depends on service configuration.', width: 720, height: 700 },
      },
      {
        id: 'profile',
        title: 'Manage your account',
        paragraphs: [
          'Account shows your display name and verified email when available. Click the UID to copy it, or select Log out to end the Companion session.',
          'Account also shows the status of Telegram and X connections. Link controls appear when the provider is available.',
        ],
        image: { file: 'account.webp', alt: 'Companion Account with a demo profile, a copyable UID and the log-out control', caption: 'Account details shown with a demo profile.', width: 720, height: 680 },
      },
      {
        id: 'sync',
        title: 'Sync your saved workspace',
        paragraphs: [
          'Your account syncs up to 100 saved tokens, notes of up to 2,000 characters, and match and alert preferences. Use Save note to sync a note. Unsaved drafts stay in your browser.',
          'If a note or setting changed on another browser, Companion lets you choose the synced version or keep your local edit. Use Retry now if the connection is interrupted.',
        ],
      },
    ],
  },
  {
    id: 'gmgn',
    label: 'GMGN',
    intro: 'Find token groups that share social links on the BNB Chain Trenches page.',
    sections: [
      {
        id: 'scan',
        title: 'Find matching tokens',
        steps: [
          'Open GMGN Trenches and select BNB Chain, or open gmgn.ai/?chain=bsc directly.',
          'With that tab active, open Kollens Companion and select Tokens → Matches to scan the rendered cards in that tab.',
        ],
        image: { file: 'matches.webp', alt: 'Companion Matches showing GREEN MORNING and SAFU token groups', caption: 'Related tokens grouped by shared social links.', width: 720, height: 968 },
      },
      {
        id: 'match-types',
        title: 'Read a match',
        paragraphs: [
          'Groups require at least two distinct contracts that share an X post, X profile, X community or Telegram destination. Choose which match types to show in Settings → Matches.',
          'MC and V show the market cap and volume displayed on the GMGN card when available. Click a shortened contract address to copy the full address or the GMGN icon to open that token.',
          'A shared destination can appear on multiple contracts. Verify the address before buying.',
        ],
      },
      {
        id: 'pause',
        title: 'Pause a match group while reviewing it',
        paragraphs: ['Hover over a group with your mouse. The Paused label shows that Companion is holding the list in place so its token rows and buy buttons stay under your pointer. Move the pointer away to resume updates.'],
        image: { file: 'paused-matches.webp', alt: 'Companion match group with the Paused label and single-token and group buy buttons', caption: 'A paused match group with example token data.', width: 720, height: 640 },
      },
      {
        id: 'save-tokens',
        title: 'Save a token and add a note',
        steps: [
          'Sign in through Profile, then click the star beside a token in Matches. Click the filled star again to remove the token from Saved.',
          'Go to Tokens → Saved to revisit a token, copy its address, open it on GMGN or use Buy. Saved rows show dashes for MC and V when the token’s card is unavailable in the active tab.',
          'Select the pencil icon, enter your private note, and choose Save note.',
        ],
        image: { file: 'saved.webp', alt: 'Companion Saved view with starred tokens and note controls', caption: 'Saved tokens and private notes.', width: 720, height: 568 },
      },
      {
        id: 'post-preview',
        title: 'Open the shared source',
        paragraphs: ['Use the source-link icon in the group header to open its shared X post, profile, community or Telegram destination.'],
      },
      {
        id: 'live-matching',
        title: 'Enable automatic matching',
        steps: [
          'On BNB Chain Trenches, open Tokens → Matches, select Enable on GMGN and approve Chrome’s site access prompt.',
          'Companion updates groups as the rendered cards change and outlines matching cards and social links. Use Settings → Matches to control the outlines.',
        ],
        paragraphs: ['Groups are scoped to each Trenches tab. To stop automatic matching, remove GMGN site access in Chrome’s extension settings.'],
      },
      {
        id: 'ai-summary',
        title: 'Read an AI summary',
        paragraphs: [
          'Click the sparkles icon beside a matching X group’s source link to read the first token’s AI summary in Companion. The same control can appear when a BNB Chain token page is active.',
          'Grant GMGN site access if Chrome asks. If the summary is missing in Trenches, turn on AI Narrative in GMGN under Customize → Data and reopen the summary. Availability varies by token. Verify any claims before using them.',
        ],
        image: { file: 'ai-summary.webp', alt: 'Companion AI summary popover showing a sample narrative and a reminder to verify claims', caption: 'The AI summary panel with an example narrative.', width: 720, height: 640 },
      },
      {
        id: 'alerts',
        title: 'Manage match alerts',
        paragraphs: ['With automatic matching enabled, open Settings → Alerts to flag new groups or tokens joining a group. You can limit alerts to groups with a saved token and enable sound. See recent alerts under Tokens → Activity.'],
        image: { file: 'alerts.webp', alt: 'Companion Page alerts settings with group, saved-token, and sound options', caption: 'Live match alert settings.', width: 720, height: 740 },
      },
    ],
  },
  {
    id: 'x',
    label: 'Trending on X',
    intro: 'See recent BNB Chain market activity and trades from wallets Kollens tracks in X’s sidebar.',
    sections: [
      {
        id: 'enable',
        title: 'Enable Trending Tokens',
        steps: [
          'Open Kollens Companion and go to Settings → About.',
          'Turn on Show trending BNB tokens and approve the X site access prompt in Chrome.',
          'Open x.com on desktop. Look for Trending Tokens above Today’s News on pages where X shows that sidebar card.',
        ],
        paragraphs: ['Turn the same setting off to remove the card and revoke the extension’s X site access.'],
        image: { file: 'trending-x.webp', alt: 'Trending Tokens on X with timeframe buttons, token metrics, and an expanded KOL list', caption: 'Trending Tokens on X with sample activity.', width: 350, height: 607 },
      },
      {
        id: 'activity',
        title: 'Read the activity',
        paragraphs: [
          'Pick a window from 5m to 24h. Tracked KOL activity ranks tokens using recent traders, trading volume and price movement when enough trades are priced.',
          'When available, Market momentum includes older tokens with rising prices and active trading in supported PancakeSwap V3 pools. Its volume and trade counts come from the selected pool.',
          'MC shows market cap when available. V shows dollar volume in the selected window. A ≥ prefix on tracked KOL volume means some trade values were unavailable.',
        ],
      },
      {
        id: 'explore-tokens',
        title: 'Explore a token or trader',
        bullets: [
          'Click a token to open its page on Kollens. Click its shortened contract address to copy the full address.',
          'Hover over token artwork to see a larger preview when an image is available.',
          'Click KOLs to see the traders behind the activity. Wallets with the same known X profile appear together. Click a linked trader name to open their profile on X.',
        ],
      },
    ],
  },
  {
    id: 'wallets',
    label: 'Wallets',
    intro: 'Create or import a wallet in Companion to receive, hold, and send native BNB on BNB Smart Chain.',
    sections: [
      {
        id: 'create-import',
        title: 'Create or import a wallet',
        bullets: [
          'In Wallets, choose Create wallet, or + Wallet if you already have wallets. Chrome stores the new wallet with an encryption key in your profile.',
          'To use an existing wallet, choose Import and enter a private key or an English recovery phrase. A phrase imports its first standard EVM address. Set a wallet password of at least eight characters.',
        ],
        note: { title: 'Back up your private key', text: 'Open the wallet’s options menu and choose View private key. Keep the key offline and private. Anyone with the key can control the wallet, and your Kollens account cannot restore it.' },
        image: { file: 'wallets.webp', alt: 'Companion Wallets showing demo balances and wallet management controls', caption: 'Wallets with example balances.', width: 720, height: 688 },
      },
      {
        id: 'transfer',
        title: 'Receive or send BNB',
        steps: [
          'For deposits, choose Receive or Deposit and copy the address. Select BNB Smart Chain in the sending wallet or exchange.',
          'To transfer BNB out, choose Send in the wallet menu. Enter the destination address and amount, then select Review transfer. Allow BNB Chain RPC access if Chrome asks.',
          'Check the network, recipient, amount, and maximum fee. Enter the wallet password if prompted, then choose Confirm send.',
          'Use Check status while the transfer is pending, or open its transaction on BscScan.',
        ],
      },
      {
        id: 'manage',
        title: 'Manage wallets and balances',
        paragraphs: [
          'Wallets shows native BNB balances. Use Refresh BNB balance to check again or View on BscScan to inspect public wallet activity.',
          'Click a wallet address to copy it, or expand the row to see its details and Deposit. Use the wallet menu to edit its alias, open BscScan or archive it.',
          'Use the checkbox to select wallets for buys. Companion remembers the selection in Chrome. Archiving deselects the wallet and keeps it available under Archived wallets → Restore wallet.',
        ],
      },
    ],
  },
  {
    id: 'trading',
    label: 'Trading',
    intro: 'Use a selected wallet and a preset BNB amount to buy a token or a group of tokens from Companion.',
    sections: [
      {
        id: 'buy-settings',
        title: 'Set your buy amounts',
        steps: [
          'In Wallets, select the wallets you want to use and check they have enough BNB for the buys and network fees.',
          'Open Settings → Buy. Set the single-token amount per wallet and the group amount per token, per wallet. Choose a preset or type a BNB amount.',
          'Use the pencil beside a preset row to edit that mode’s four amounts. Choose Save presets to keep your changes.',
          'Set slippage separately for each buy mode and enter the maximum network fee per buy. Choose Same tab or New tab for GMGN after a single-token buy, then select Save buy settings.',
        ],
        image: { file: 'settings.webp', alt: 'Companion Buy settings with separate single-token and group-buy amounts, presets, and slippage controls', caption: 'Buy settings for single tokens and groups.', width: 720, height: 1340 },
      },
      {
        id: 'place-buy',
        title: 'Buy a token or group',
        paragraphs: [
          'From Tokens, choose Buy on a row in Matches or Saved, or choose Buy all on a match group. Each wallet and token pair is a separate order. A request can include up to 24 orders.',
          'For password-protected wallets, enter the requested passwords and select Unlock and buy. A buy using only device-protected wallets can begin submitting as soon as you click the buy button and allow BNB Chain RPC access.',
          'Companion can use supported Four.Meme, Flap, and direct PancakeSwap V2 routes on BNB Smart Chain. Route availability depends on the token and current liquidity.',
          'The extension checks the quote, slippage limit, balance, and fee cap before it signs. Prices can move after a quote, and a submitted transaction can fail.',
        ],
        note: { title: 'Check the total before buying', text: 'For Buy all, multiply the group amount by the number of tokens and selected wallets. Network fees apply per transaction.' },
      },
      {
        id: 'buy-status',
        title: 'Check your buy status',
        paragraphs: [
          'Keep Companion open while orders are submitting. Open Buy activity from the Tokens header and select Check pending buys, or follow View on BscScan when a transaction hash is available.',
          'Submitted means the transaction is waiting for confirmation. Check BscScan before retrying an unconfirmed submission. A group can have mixed results because orders are sent separately. Reverted orders can still incur a network fee.',
        ],
        image: { file: 'buy-activity.webp', alt: 'Companion Buy activity showing a pending order and a Check pending buys button', caption: 'Buy activity with an example pending order.', width: 720, height: 660 },
      },
    ],
  },
  {
    id: 'privacy',
    label: 'Privacy & permissions',
    intro: 'Your browser holds wallet keys, and you choose which sites Companion can access.',
    sections: [
      {
        id: 'site-access',
        title: 'What each permission is for',
        bullets: [
          'kollens.com provides the trending feed, account sign-in, and workspace sync.',
          'The active GMGN tab supplies rendered token cards and social links when you open the matching workspace. Optional GMGN site access lets Companion follow card changes, highlight matches, and read AI summaries from the page.',
          'Optional x.com access lets Companion place Trending Tokens in the X sidebar. Manage it from Settings → About or the extension’s Details page in Chrome.',
          'The BNB Chain RPC looks up public wallet balances, checks quotes and fees, and broadcasts transactions your wallet signs.',
        ],
      },
      {
        id: 'local-and-synced',
        title: 'What stays local and what syncs',
        paragraphs: [
          'Wallet keys are encrypted in the Chrome profile where you create or import them. Transactions are signed in the extension. Your Kollens account syncs saved token identities, notes you save, and matching and alert preferences.',
          'GMGN scans and matching groups stay in the browser. Unsaved note drafts stay local until you save them.',
          'Use Profile → Log out to end your Companion session. Wallet access still depends on your Chrome profile and any wallet password. Broadcast transactions are recorded publicly on BNB Smart Chain.',
        ],
        note: { title: 'Keep secrets in the wallet', text: 'Enter a recovery phrase or private key only in the Companion import form when you choose to import. Kollens support will never ask you to send your private key, recovery phrase, or wallet password.' },
      },
    ],
  },
  {
    id: 'help',
    label: 'Troubleshooting',
    intro: 'Check the page, your browser permissions, and the latest extension build when something looks wrong.',
    sections: [
      {
        id: 'gmgn-missing',
        title: 'GMGN matches are missing',
        paragraphs: ['Make the BNB Chain Trenches tab active and reopen Tokens → Matches. For live updates, select Enable on GMGN and check Chrome’s site access. Check Settings → Matches for your enabled match types. A group needs two distinct contracts rendered on the page that share a supported link.'],
      },
      {
        id: 'x-missing',
        title: 'Trending Tokens is missing on X',
        paragraphs: ['Check that Show trending BNB tokens is enabled under Settings → About and that Chrome granted x.com access. Refresh a desktop X page that displays Today’s News in the sidebar. If the card is present but the list is empty, try a longer time window.'],
      },
      {
        id: 'wallet-help',
        title: 'A balance or transaction status is unavailable',
        paragraphs: ['Refresh the balance or check the order in Buy activity. If the RPC request timed out or a submission is unconfirmed, check the transaction on BscScan before trying a new order.'],
      },
      {
        id: 'sign-in-help',
        title: 'Sign-in or sync is interrupted',
        paragraphs: ['Finish Google sign-in in Chrome’s authorization window, then reopen Profile. If sync is interrupted, use Retry now when it appears. Check Saved for notes that need review.'],
      },
    ],
  },
];
