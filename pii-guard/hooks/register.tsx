import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.ui.log('pii-guard loaded', { to: 'debug' })
    return next(e)
  })
}
