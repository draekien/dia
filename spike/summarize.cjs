const results = require(require('node:path').resolve(process.argv[2]))
console.log({ packaged: results.packaged, electron: results.electron, node: results.node, esbuildBinaryExists: results.esbuildBinaryExists, tsxLoaderPath: results.tsxLoaderPath })
for (const run of results.runs) {
  console.log(`## ${run.variant} ${run.exitCode ?? ''}`)
  for (const message of run.messages ?? []) {
    if (message.task === 'hello') continue
    const { task, ok, ...rest } = message
    console.log(`   ${ok ? 'PASS' : 'FAIL'} ${task} ${JSON.stringify(rest).slice(0, 300)}`)
  }
  if (run.probe) console.log(`   ${JSON.stringify(run.probe)}`)
  if (run.stderr) console.log(`   STDERR ${run.stderr.slice(0, 600)}`)
}
