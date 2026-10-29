// Refuses a remote Wrangler command while wrangler.toml still points
// at the local-dev sentinel (or at the upstream GatherOS D1 database
// this fork was copied from). Local `wrangler dev` does not run this.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SENTINEL = '00000000-0000-0000-0000-000000000000';
// Historical upstream database id. Deploying this fork with that id
// would read and write the upstream account's D1 database.
const UPSTREAM_D1 = '4ee66c06-85c5-4b0d-9286-051a4276a99c';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'wrangler.toml');
const text = fs.readFileSync(file, 'utf8');
const match = text.match(/^\s*database_id\s*=\s*"([^"]*)"\s*$/m);
const id = match ? match[1] : '';

if (!id) {
  console.error('wrangler.toml is missing [[d1_databases]] database_id.');
  process.exit(1);
}
if (id === SENTINEL) {
  console.error(
    'database_id is still the local-dev sentinel.\n' +
      'Create your own database and paste its id into server/wrangler.toml:\n' +
      '  cd server && npx wrangler d1 create gatheros-db',
  );
  process.exit(1);
}
if (id === UPSTREAM_D1) {
  console.error(
    'database_id is the upstream GatherOS database. Create a database in your own Cloudflare account instead.',
  );
  process.exit(1);
}
console.log('wrangler.toml database_id is set to your own database.');
