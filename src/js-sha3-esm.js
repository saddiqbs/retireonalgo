// Import from the actual CJS file path to avoid circular alias
import sha3 from '../node_modules/js-sha3/src/sha3.js'
export const keccak_256 = sha3.keccak_256
export const keccak_512 = sha3.keccak_512
export const keccak_384 = sha3.keccak_384
export const keccak_224 = sha3.keccak_224
export const sha3_256 = sha3.sha3_256
export const sha3_512 = sha3.sha3_512
export const sha3_384 = sha3.sha3_384
export const sha3_224 = sha3.sha3_224
export const shake_128 = sha3.shake_128
export const shake_256 = sha3.shake_256
export default sha3
