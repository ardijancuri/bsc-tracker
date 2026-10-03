import { describe, expect, it } from 'vitest';
import { flapLogoFromHtml, flapMetadataUri, geniusLogoFromHtml, normalizeLogoUrl, imageCandidateUrls } from './tokenLogo.js';

const address = '0xbbf4431aacfc2b22dff09d2bc21fb0775c1c7777';

it('preserves IPFS image paths across independent gateways', () => {
  const cid = 'bafkreibvcilgl2johr2xq4uifh2e6todmuy6tafvdppq4neq3dipzu67oe';
  expect(normalizeLogoUrl(`${cid}/logo.png`)).toBe(`https://gateway.pinata.cloud/ipfs/${cid}/logo.png`);
  const candidates = imageCandidateUrls(`ipfs://${cid}/logo.png`);
  expect(candidates).toHaveLength(3);
  expect(candidates).toContain(`https://ipfs.filebase.io/ipfs/${cid}/logo.png`);
  expect(imageCandidateUrls('javascript:alert(1)')).toEqual([]);
});

describe('Flap token logo extraction', () => {
  it('reads complete streamed metadata with long descriptions and nested quote-token artwork', () => {
    const coin = { name: 'name'.repeat(200), address, quoteToken: { metadata: { image: 'https://example.com/pair.png' } },
      metadata: { description: 'Long text with "quotes" and {braces}.'.repeat(100), image: 'https://wiredup.fun/own.png' } };
    const html = `<script>self.__next_f.push(${JSON.stringify([1, `1:${JSON.stringify({ coin })}`])})</script>`;
    expect(flapLogoFromHtml(html, address)).toBe('https://wiredup.fun/own.png');
    coin.metadata.image = '';
    expect(flapLogoFromHtml(`<script>self.__next_f.push(${JSON.stringify([1, JSON.stringify({ coin })])})</script>`, address)).toBeNull();
  });

  it('decodes the contract metadata CID and rejects malformed ABI or non-IPFS metadata', () => {
    const cid = 'QmabJ9DdYZpq2K2XHJMHprma4gm5yUVbFjdZdsp6AF6UHc';
    const abi = (value: string, offset = 32) => `0x${offset.toString(16).padStart(64, '0')}${Buffer.byteLength(value).toString(16).padStart(64, '0')}${Buffer.from(value).toString('hex').padEnd(Math.ceil(Buffer.byteLength(value) / 32) * 64, '0')}`;
    expect(flapMetadataUri(abi(cid))).toBe(`https://flap.mypinata.cloud/ipfs/${cid}`);
    expect(flapMetadataUri(abi(`ipfs://${cid}`))).toBe(`https://flap.mypinata.cloud/ipfs/${cid}`);
    expect(flapMetadataUri(abi(cid, 64))).toBeNull();
    expect(flapMetadataUri(abi('https://127.0.0.1/private'))).toBeNull();
    expect(flapMetadataUri(abi(cid).slice(0, 130))).toBeNull();
    expect(flapMetadataUri('0x')).toBeNull();
  });
  it('reads the current token metadata image regardless of its host', () => {
    const html = `self.__next_f.push([1,"{\\"coin\\":{\\"name\\":\\"HEYICOIN\\",\\"address\\":\\"${address}\\",\\"symbol\\":\\"HEYI\\",\\"metadata\\":{\\"description\\":\\"\\",\\"image\\":\\"https://wiredup.fun/uploads/heyicoins.png\\"}}"]);`;
    expect(flapLogoFromHtml(html, address)).toBe('https://wiredup.fun/uploads/heyicoins.png');
  });

  it('resolves a bare IPFS CID from FlapCat metadata', () => {
    const flapCat = '0xc92c66549abbcdcd6b050f9ac4df2652323f7777';
    const cid = 'bafkreibvcilgl2johr2xq4uifh2e6todmuy6tafvdppq4neq3dipzu67oe';
    const html = `\\"coin\\":{\\"address\\":\\"${flapCat}\\",\\"metadata\\":{\\"image\\":\\"${cid}\\"}}`;
    expect(flapLogoFromHtml(html, flapCat)).toBe(`https://flap.mypinata.cloud/ipfs/${cid}`);
    expect(flapLogoFromHtml(html.replace(cid, `ipfs://${cid}`), flapCat)).toBe(`https://flap.mypinata.cloud/ipfs/${cid}`);
    expect(normalizeLogoUrl(`https://flap.mypinata.cloud/ipfs/${cid}`)).toBe(`https://flap.mypinata.cloud/ipfs/${cid}`);
  });

  it('ignores another token and non-image schemes', () => {
    const html = `\\"coin\\":{\\"address\\":\\"${address}\\",\\"metadata\\":{\\"image\\":\\"javascript:alert(1)\\"}}`;
    expect(flapLogoFromHtml(html, address)).toBeNull();
    expect(flapLogoFromHtml(html, '0x207529c7aeed063e02fee9a1c07e801792b67777')).toBeNull();
  });
});

describe('Genius.fun token logo extraction', () => {
  it('uses the token image served by the matching contract page', () => {
    const gstonk = '0xc1e1ffea92c932eb0ff6c74fae43db477abc9165';
    const cid = 'bafkreicgcdz5sus2ebkn6sopnpyr6b6c7535xq2gtpn6h2idjsmtnmp5ua';
    const path = `/api/image?src=ipfs%3A%2F%2F${cid}`;
    const html = `<link rel="preload" as="image" href="${path}"/><a href="https://bscscan.com/address/${gstonk}">Contract</a>`;
    expect(geniusLogoFromHtml(html, gstonk)).toBe(`https://genius.fun${path}`);
    expect(geniusLogoFromHtml(html, address)).toBeNull();
    const meta = `<meta property="og:image" content="https://genius.fun${path}"/><span>${gstonk}</span>`;
    expect(geniusLogoFromHtml(meta, gstonk)).toBe(`https://genius.fun${path}`);
  });

  it('rejects unsafe image schemes', () => {
    expect(normalizeLogoUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeLogoUrl('ipfs://bafkreibvcilgl2johr2xq4uifh2e6todmuy6tafvdppq4neq3dipzu67oe')).toBe('https://gateway.pinata.cloud/ipfs/bafkreibvcilgl2johr2xq4uifh2e6todmuy6tafvdppq4neq3dipzu67oe');
  });
});
