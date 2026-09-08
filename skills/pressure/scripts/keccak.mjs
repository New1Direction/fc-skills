/** Ethereum Keccak-256: original implementation of the public Keccak-f[1600] algorithm. */
const MASK = (1n << 64n) - 1n;
const RC = [1n,0x8082n,0x800000000000808an,0x8000000080008000n,0x808bn,0x80000001n,
  0x8000000080008081n,0x8000000000008009n,0x8an,0x88n,0x80008009n,0x8000000an,
  0x8000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,
  0x8000000000008002n,0x8000000000000080n,0x800an,0x800000008000000an,
  0x8000000080008081n,0x8000000000008080n,0x80000001n,0x8000000080008008n];
const ROT = [[0n,36n,3n,41n,18n],[1n,44n,10n,45n,2n],[62n,6n,43n,15n,61n],
  [28n,55n,25n,21n,56n],[27n,20n,39n,8n,14n]];
const rol = (v,n) => ((v << n) | (v >> ((64n-n)%64n))) & MASK;
export function keccak256(input) {
  if (!(input instanceof Uint8Array)) throw new TypeError('Keccak input must be bytes');
  const padding = 136 - input.length % 136;
  const padded = Buffer.alloc(input.length + padding);
  padded.set(input); padded[input.length] = 1; padded[padded.length-1] |= 128;
  const a = Array(25).fill(0n);
  for (let offset=0;offset<padded.length;offset+=136) {
    for (let i=0;i<17;i++) a[i] ^= padded.readBigUInt64LE(offset+i*8);
    for (const rc of RC) {
      const c = Array.from({length:5},(_,x)=>a[x]^a[x+5]^a[x+10]^a[x+15]^a[x+20]);
      const d = c.map((_,x)=>c[(x+4)%5]^rol(c[(x+1)%5],1n));
      for(let x=0;x<5;x++) for(let y=0;y<5;y++) a[x+5*y]^=d[x];
      const b=Array(25).fill(0n);
      for(let x=0;x<5;x++) for(let y=0;y<5;y++) b[y+5*((2*x+3*y)%5)]=rol(a[x+5*y],ROT[x][y]);
      for(let x=0;x<5;x++) for(let y=0;y<5;y++) a[x+5*y]=b[x+5*y]^((~b[(x+1)%5+5*y])&b[(x+2)%5+5*y]);
      a[0]^=rc;
    }
  }
  const result=Buffer.alloc(32);
  for(let i=0;i<4;i++) result.writeBigUInt64LE(a[i],i*8);
  return result;
}
export const keccakHex = input => '0x'+keccak256(input).toString('hex');
