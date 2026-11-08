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
          'Use Wallets, Tokens, Settings, and Profile in the toolbar popup. Choose Open side panel to keep the workspace visible beside your tab.',
          'Open Profile and choose Continue with Google to sync your saved tokens, notes, and matching preferences. You can browse matches and trending tokens before signing in.',
        ],
        image: { file: 'account.webp', alt: 'Companion Profile with a demo account and the log-out control', caption: 'Profile with a demo account.', width: 720, height: 680 },
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
          'With that tab active, open Kollens Companion and select Tokens → Matches. The download scans the cards rendered on the current page when you open the workspace.',
          'Review the tokens in each group. Use the source-link icon to visit the shared link or the GMGN icon to open a token’s page.',
        ],
        note: { title: 'On-demand scan', text: 'The downloadable build shows a snapshot of the active GMGN tab. Reopen the workspace for a fresh view after the page changes. Continuous scanning, page highlights, and live match alerts are part of a separate test build.' },
        image: { file: 'matches.webp', alt: 'Companion Matches showing GREEN MORNING and SAFU token groups', caption: 'Related tokens grouped by shared social links.', width: 720, height: 968 },
      },
      {
        id: 'match-types',
        title: 'Read a match',
        paragraphs: [
          'Groups require at least two distinct token contracts. Match types include the same X post, X profile, X community, or Telegram link. Choose which types appear in Settings → Matches.',
          'Companion compares the supported social links available on the rendered cards. Groups can change as GMGN loads more cards or as you switch pages.',
          'A shared link tells you which contracts use the same destination. Verify the contract address before acting on a match.',
        ],
      },
      {
        id: 'save-tokens',
        title: 'Save a token and add a note',
        steps: [
          'Sign in through Profile, then click the star beside a token in Matches.',
          'Go to Tokens → Saved and choose Edit note to add a private note.',
          'If the same note changed on another browser, choose Use synced version or Keep my draft.',
        ],
        image: { file: 'saved.webp', alt: 'Companion Saved view with starred tokens and note controls', caption: 'Saved tokens and private notes.', width: 720, height: 568 },
      },
      {
        id: 'post-preview',
        title: 'Preview a shared X post',
        paragraphs: ['In the test build, hover over a group’s X source icon to preview the post text and any available images. The source icon also opens the original post.'],
        image: { file: 'post-preview.webp', alt: 'A shared X post preview beside a matching token group in Companion', caption: 'Shared post preview in the test build.', width: 960, height: 968 },
      },
      {
        id: 'alerts',
        title: 'Manage match alerts',
        paragraphs: ['In the test build, Page alerts can flag a new group or a token joining an existing group. Choose whether alerts are limited to saved tokens and whether they play a sound.'],
        image: { file: 'alerts.webp', alt: 'Companion Page alerts settings with group, saved-token, and sound options', caption: 'Live match alert settings in the test build.', width: 720, height: 740 },
      },
    ],
  },
  {
    id: 'x',
    label: 'Trending on X',
    intro: 'See recent BNB Chain activity from wallets Kollens tracks, directly in X’s sidebar.',
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
          'Pick a window from 5m to 24h. Kollens ranks tokens by the number of tracked wallets that bought or sold during that window. The card shows the buy and sell counts alongside market cap and tracked volume.',
          'MC shows market cap when available. V shows the dollar value of known buys and sells from tracked wallets in your selected window. A ≥ prefix means some trade values were unavailable.',
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
          'To transfer BNB out, choose Send in the wallet menu. Enter the destination address and amount, then select Review transfer.',
          'Check the network, recipient, amount, and maximum fee. Enter the wallet password if prompted, then choose Confirm send.',
        ],
      },
      {
        id: 'manage',
        title: 'Manage wallets and balances',
        paragraphs: [
          'Wallets shows native BNB balances. Use Refresh BNB balance to check again or View on BscScan to inspect public wallet activity.',
          'Use the checkbox to select wallets for buys. You can Edit alias, Archive wallet, or find it again under Archived wallets and choose Restore wallet.',
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
          'Open Settings → Buy. Set the Single token amount per wallet and the Group buy amount per token, per wallet.',
          'Set slippage separately for each buy mode and enter the maximum network fee per buy. Choose how to open GMGN after a single buy, then select Save buy settings.',
        ],
        image: { file: 'settings.webp', alt: 'Companion Buy settings with separate single-token and group-buy amounts, presets, and slippage controls', caption: 'Buy settings for single tokens and groups.', width: 720, height: 1340 },
      },
      {
        id: 'place-buy',
        title: 'Buy a token or group',
        paragraphs: [
          'From Tokens, choose Buy on a token row or Buy all on a match group. Each wallet and token pair is a separate order. A request can include up to 24 orders.',
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
          'Keep the window open while buys are submitting. Use Buy activity and Check pending buys to check each order, or follow View on BscScan for a transaction hash.',
          'Submitted means the transaction is waiting for confirmation. A group can have mixed results because its orders are sent separately. A reverted transaction can still incur a network fee.',
        ],
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
          'The active GMGN tab supplies rendered token cards and social links when you open the matching workspace.',
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
        paragraphs: ['Make the BNB Chain Trenches tab active and reopen Tokens → Matches. Check Settings → Matches for your enabled match types. The scan needs two distinct contracts rendered on the page that share a supported link.'],
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
        paragraphs: ['Finish Google sign-in in Chrome’s sign-in window, then reopen Companion and check Profile. If sync is interrupted, use Retry now when it appears and check Saved for notes that still need review.'],
      },
    ],
  },
];
