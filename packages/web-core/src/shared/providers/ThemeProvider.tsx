import { useEffect, useState, type ReactNode } from 'react';
import { ThemeMode } from 'shared/types';
import { ThemeProviderContext } from '@/shared/hooks/useTheme';
import { applyPrimaryColor, applyTheme } from '@/shared/lib/themeColors';

interface ThemeProviderProps {
  children: ReactNode;
  initialTheme?: ThemeMode;
  initialPrimaryColor?: string;
}

export function ThemeProvider({
  children,
  initialTheme = ThemeMode.SYSTEM,
  initialPrimaryColor,
}: ThemeProviderProps) {
  const [theme, setTheme] = useState(initialTheme);

  useEffect(() => setTheme(initialTheme), [initialTheme]);
  useEffect(
    () => applyPrimaryColor(initialPrimaryColor),
    [initialPrimaryColor]
  );
  useEffect(() => applyTheme(theme), [theme]);

  return (
    <ThemeProviderContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeProviderContext.Provider>
  );
}
