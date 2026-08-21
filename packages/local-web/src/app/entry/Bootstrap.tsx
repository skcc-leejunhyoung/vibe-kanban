import React from 'react';
import ReactDOM from 'react-dom/client';
import { ClickToComponent } from 'click-to-react-component';
import { QueryClientProvider } from '@tanstack/react-query';
import App from '@web/app/entry/App';
import { AppErrorBoundary } from '@/shared/components/AppErrorBoundary';
import '@/i18n';
import { oauthApi } from '@/shared/lib/api';
import { tokenManager } from '@/shared/lib/auth/tokenManager';
import { configureAuthRuntime } from '@/shared/lib/auth/runtime';
import '@/shared/types/modals';
import { queryClient } from '@/shared/lib/queryClient';
import { installAppZoom } from '@/shared/lib/zoom';

installAppZoom();

configureAuthRuntime({
  getToken: () => tokenManager.getToken(),
  triggerRefresh: () => tokenManager.triggerRefresh(),
  registerShape: (shape) => tokenManager.registerShape(shape),
  getCurrentUser: () => oauthApi.getCurrentUser(),
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppErrorBoundary>
        <ClickToComponent />
        <App />
      </AppErrorBoundary>
    </QueryClientProvider>
  </React.StrictMode>
);
