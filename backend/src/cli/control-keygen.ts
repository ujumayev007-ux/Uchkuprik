// Generates the central server's Ed25519 signing key pair.
//   npm run control:keygen -w backend
// The PRIVATE key goes only into the central server's environment
// (CONTROL_SIGNING_KEY). The PUBLIC key is baked into customer builds
// (CONTROL_PUBLIC_KEY / control.json); it is not a secret.
import { generateIdentity } from '../modules/control/keys.js';

const identity = generateIdentity();
console.log('CONTROL_PUBLIC_KEY=' + identity.publicKey);
console.log(
  'CONTROL_SIGNING_KEY=' +
    Buffer.from(identity.privateKeyPem).toString('base64'),
);
console.error(
  'Store CONTROL_SIGNING_KEY only on the central server. Never commit it.',
);
