import { test, expect } from 'claude-code/testing'

test('module loads and session.start passes through', async ($, on) => {
  let reached = false
  on('session.start', ($, e) => {
    reached = true
    return { cwd: e.cwd }
  })
  on('ui.log', () => ({ value: undefined }))
  await $.session.start({ cwd: 'E:/x', surface: 'terminal', isInteractive: true })
  expect(reached).toBe(true)
})
