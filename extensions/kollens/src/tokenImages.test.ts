import{describe,it,expect}from'vitest';
import{extensionTokenImageUrl}from'../../../shared/extension';
describe('public token thumbnail URLs',()=>{
  it('keeps public HTTPS artwork and resolves rendered relative paths',()=>{
    expect(extensionTokenImageUrl('https://cdn.gmgn.ai/token/photo.webp?v=2#ignored')).toBe('https://cdn.gmgn.ai/token/photo.webp?v=2');
    expect(extensionTokenImageUrl('/defi/images/token/photo.webp','https://gmgn.ai/?chain=bsc')).toBe('https://gmgn.ai/defi/images/token/photo.webp');
    expect(extensionTokenImageUrl('https://images.example.org/token.png')).toBe('https://images.example.org/token.png');
  });
  it.each([undefined,null,42,'','javascript:alert(1)','data:image/svg+xml,<svg/>','blob:https://gmgn.ai/abc','file:///C:/private.png',
    'http://cdn.gmgn.ai/image.png','https://user:password@cdn.gmgn.ai/image.png','https://localhost/image.png','https://127.0.0.1/image.png',
    'https://0x7f000001/image.png','https://[::1]/image.png','https://server.internal/image.png','https://cdn.gmgn.ai:8443/image.png',
    'https://cdn.gmgn.ai/'+ 'x'.repeat(2048)])('rejects unsafe or unbounded artwork: %s',value=>expect(extensionTokenImageUrl(value)).toBeNull());
});
