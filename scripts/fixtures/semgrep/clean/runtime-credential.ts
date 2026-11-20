/** Fixture: a credential resolved at runtime must not be reported. */

/** Bearer key resolved from the environment. */
export const apiKey = process.env.DSH_FIXTURE_API_KEY ?? ''

/** Empty placeholder that a deployment fills in. */
export const token = ''
