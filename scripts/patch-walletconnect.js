import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const file = resolve(__dirname, '../node_modules/@walletconnect/utils/dist/esm/ethereum.js')

try {
  let code = readFileSync(file, 'utf8')
  if (code.includes('import { keccak_256 } from "js-sha3"')) {
    code = code.replace(
      'import { keccak_256 } from "js-sha3";',
      'import sha3 from "js-sha3";\nconst keccak_256 = sha3.keccak_256;'
    )
    writeFileSync(file, code)
    console.log('Patched @walletconnect/utils: fixed js-sha3 ESM import')
  } else {
    console.log('Patch already applied or file changed')
  }
} catch (e) {
  console.warn('Could not patch @walletconnect/utils:', e.message)
}
