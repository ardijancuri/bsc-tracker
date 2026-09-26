import { describe, expect, it } from 'vitest';
import { flapLogoFromHtml } from './tokenLogo.js';

const address = '0xbbf4431aacfc2b22dff09d2bc21fb0775c1c7777';

describe('Flap token logo extraction', () => {
  it('reads the current token metadata image regardless of its host', () => {
    const html = `self.__next_f.push([1,"{\\"coin\\":{\\"name\\":\\"HEYICOIN\\",\\"address\\":\\"${address}\\",\\"symbol\\":\\"HEYI\\",\\"metadata\\":{\\"description\\":\\"\\",\\"image\\":\\"https://wiredup.fun/uploads/heyicoins.png\\"}}"]);`;
    expect(flapLogoFromHtml(html, address)).toBe('https://wiredup.fun/uploads/heyicoins.png');
  });

  it('resolves a bare IPFS CID from FlapCat metadata', () => {
    const flapCat = '0xc92c66549abbcdcd6b050f9ac4df2652323f7777';
    const cid = 'bafkreibvcilgl2johr2xq4uifh2e6todmuy6tafvdppq4neq3dipzu67oe';
    const html = `\\"coin\\":{\\"address\\":\\"${flapCat}\\",\\"metadata\\":{\\"image\\":\\"${cid}\\"}}`;
    expect(flapLogoFromHtml(html, flapCat)).toBe(`https://gateway.pinata.cloud/ipfs/${cid}`);
    expect(flapLogoFromHtml(html.replace(cid, `ipfs://${cid}`), flapCat)).toBe(`https://gateway.pinata.cloud/ipfs/${cid}`);
  });

  it('ignores another token and non-image schemes', () => {
    const html = `\\"coin\\":{\\"address\\":\\"${address}\\",\\"metadata\\":{\\"image\\":\\"javascript:alert(1)\\"}}`;
    expect(flapLogoFromHtml(html, address)).toBeNull();
    expect(flapLogoFromHtml(html, '0x207529c7aeed063e02fee9a1c07e801792b67777')).toBeNull();
  });
});
