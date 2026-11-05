import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it.each([undefined, 'https://central.test'])(
  'keeps build API bases consistent with configured value %s',
  (configured) => {
    const source = readFileSync(
      new URL('../../../../../local-build.sh', import.meta.url),
      'utf8'
    );
    const assignments = source
      .split('\n')
      .filter((line) =>
        /^export (VK_SHARED_API_BASE|VITE_VK_SHARED_API_BASE)=/.test(line)
      )
      .join('\n');
    const result = execFileSync(
      '/bin/bash',
      [
        '-c',
        `${assignments}\nprintf '%s\\n%s' "$VK_SHARED_API_BASE" "$VITE_VK_SHARED_API_BASE"`,
      ],
      {
        env: {
          VK_SHARED_API_BASE: configured ?? '',
          VITE_VK_SHARED_API_BASE: 'https://wrong.test',
        },
        encoding: 'utf8',
      }
    );
    expect(result.split('\n')).toEqual(
      Array(2).fill(configured ?? 'https://api.vibekanban.com')
    );
  }
);
