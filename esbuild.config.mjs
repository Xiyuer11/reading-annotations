import esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'main.js',
  format: 'cjs',
  platform: 'node',
  target: 'es2020',
  sourcemap: isWatch ? 'inline' : false,
  external: ['obsidian', 'electron', '@codemirror/state', '@codemirror/view'],
  logLevel: 'info',
});

if (isWatch) {
  await context.watch();
  console.log('watching...');
} else {
  await context.rebuild();
  await context.dispose();
}
