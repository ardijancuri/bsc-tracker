import { describe, expect, it } from 'vitest';
import { flapLogoFromHtml, geniusLogoFromHtml, normalizeLogoUrl, imageCandidateUrls } from './tokenLogo.js';

const address = '0xbbf4431aacfc2b22dff09d2bc21fb0775c1c7777';

it('preserves IPFS image paths across independent gateways', () => {
  const cid = 'bafkreibvcilgl2johr2xq4uifh2e6todmuy6tafvdppq4neq3dipzu67oe';
  expect(normalizeLogoUrl(`${cid}/logo.png`)).toBe(`https://gateway.pinata.cloud/ipfs/${cid}/logo.png`);
  const candidates = imageCandidateUrls(`ipfs://${cid}/logo.png`);
  expect(candidates).toHaveLength(4);
  expect(candidates).toContain(`https://ipfs.io/ipfs/${cid}/logo.png`);
  expect(imageCandidateUrls('javascript:alert(1)')).toEqual([]);
});

describe('Flap token logo extraction', () => {
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
