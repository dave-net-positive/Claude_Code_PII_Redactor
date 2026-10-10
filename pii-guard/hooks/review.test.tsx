import { test, expect, mock } from 'claude-code/testing'

export const paneProps = {
  title: 'PII review',
  isFocused: true,
  bodyColumns: 100,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`with no review pending the pane draws the settings view on ${surface}`, async ($, on) => {
    mock.store(on, { config: { version: 1, types: [], watchlist: ['Joanna'], allowlist: ['foo'], scanToolReads: false } })
    const ui = await $.ui.mount({
      plugin: 'pii-guard', surface, component: 'Pane', requestId: 'pii-guard', props: paneProps,
    })
    expect(await ui.find({ key: 'type:email:off' })).toBeTruthy()
    expect(await ui.find({ key: 'watch:remove:Joanna' })).toBeTruthy()
    expect(await ui.find({ key: 'allow:remove:foo' })).toBeTruthy()
    expect(await ui.find({ key: 'reads:on' })).toBeTruthy()
    expect(await ui.find({ key: 'watch:add' })).toBeTruthy()
    expect((await ui.find({ key: 'back' }))?.props.label).toBe('Close')
  })

  test(`settings buttons change config and the pane redraws on ${surface}`, async ($, on) => {
    mock.store(on)
    on('ui.close', () => ({ value: undefined }))
    const ui = await $.ui.mount({
      plugin: 'pii-guard', surface, component: 'Pane', requestId: 'pii-guard', props: paneProps,
    })
    await ui.press({ key: 'type:email:off' })
    expect(await ui.find({ key: 'type:email:on' })).toBeTruthy()
    await ui.press({ key: 'reads:on' })
    expect(await ui.find({ key: 'reads:off' })).toBeTruthy()
    await ui.input({ key: 'watch:add', text: 'Joanna Bloggs' })
    expect(await ui.find({ key: 'watch:remove:Joanna Bloggs' })).toBeTruthy()
    await ui.press({ key: 'watch:remove:Joanna Bloggs' })
    expect(await ui.find({ key: 'watch:remove:Joanna Bloggs' })).toBeFalsy()
  })
}
