'use client';
import type { ReactNode } from 'react';
import { Toast } from '@base-ui/react/toast';
import { CircleAlert, CircleCheck, X } from 'lucide-react';

const manager = Toast.createToastManager();

/**
 * Brief confirmation for a finished action: saved, copied, downloaded.
 * Errors that need the user's attention stay next to the control that failed.
 */
export const toast = {
  success: (title: string, description?: string) =>
    manager.add({ title, description, type: 'success' }),
  error: (title: string, description?: string) =>
    manager.add({ title, description, type: 'error', priority: 'high', timeout: 8000 }),
};

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider toastManager={manager} timeout={3500} limit={3}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="ui-toast-viewport">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((item) => (
    <Toast.Root key={item.id} toast={item} className="ui-toast">
      {item.type === 'error' ? <CircleAlert size={16} aria-hidden="true" /> : <CircleCheck size={16} aria-hidden="true" />}
      <div className="ui-toast-body">
        <Toast.Title render={<strong />} />
        {item.description && <Toast.Description render={<p />} />}
      </div>
      <Toast.Close className="ui-toast-close" aria-label="关闭提示">
        <X size={14} />
      </Toast.Close>
    </Toast.Root>
  ));
}
