import { registerAs } from '@nestjs/config';

const TRUTHY = ['true', '1', 'yes'];
const FALSY = ['false', '0', 'no'];

export default registerAs('security', () => {
  const apiKey = process.env.API_KEY?.trim() ?? '';
  const rawEnabled = process.env.API_KEY_ENABLED?.trim().toLowerCase();

  let enabled: boolean;

  if (!rawEnabled) {
    // A key that is configured implies the guard is wanted; there is no reason
    // to set both, and forgetting the flag would silently expose the API.
    enabled = apiKey.length > 0;
  } else if (TRUTHY.includes(rawEnabled)) {
    enabled = true;
  } else if (FALSY.includes(rawEnabled)) {
    enabled = false;
  } else {
    throw new Error(
      `API_KEY_ENABLED must be one of: ${[...TRUTHY, ...FALSY].join(', ')}, received "${process.env.API_KEY_ENABLED}"`,
    );
  }

  // Enabling the guard with no key would lock the operator out of their own
  // tool with no way back in except editing the environment.
  if (enabled && !apiKey) {
    throw new Error(
      'API_KEY must be set when API_KEY_ENABLED is true — the API would otherwise be unreachable.',
    );
  }

  return { enabled, apiKey };
});
