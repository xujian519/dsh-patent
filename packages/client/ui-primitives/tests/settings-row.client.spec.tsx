// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsRow, Switch } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

describe('SettingsRow', () => {
  it('renders the copy beside the trailing control', () => {
    render(<SettingsRow
      title="Preference"
      description="What it does"
      control={<Switch checked={false} label="Preference" onChange={() => {}} />}
    />)
    expect(screen.getByText('Preference')).toBeDefined()
    expect(screen.getByText('What it does')).toBeDefined()
    expect(screen.getByRole('switch', { name: 'Preference' })).toBeDefined()
  })

  it('renders the optional alert under the description', () => {
    render(<SettingsRow
      title="Preference"
      description="What it does"
      alert={<div role="alert">Could not save</div>}
      control={<Switch checked onChange={() => {}} label="Preference" />}
    />)
    expect(screen.getByRole('alert').textContent).toBe('Could not save')
  })
})
