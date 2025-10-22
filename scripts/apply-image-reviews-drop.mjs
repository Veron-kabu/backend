import { spawn } from 'node:child_process';

// Convenience script to run drizzle-kit migrations that include the image_reviews drop
const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: 'inherit', shell: true, ...opts });
  p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)));
});

async function main() {
  try {
    console.log('Running database migrations...');
    await run('npx', ['drizzle-kit', 'migrate']);
    console.log('Migrations complete.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

main();
