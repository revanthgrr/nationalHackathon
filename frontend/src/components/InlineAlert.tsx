/**
 * InlineAlert — clean, modern light status alert with icon.
 */

interface Props {
  type: 'success' | 'error' | 'info';
  message: string;
}

const styles: Record<Props['type'], { container: string; icon: string }> = {
  success: {
    container: 'bg-emerald-50 border-emerald-300 text-emerald-800',
    icon: '✓',
  },
  error: {
    container: 'bg-rose-50 border-rose-300 text-rose-800',
    icon: '⚠',
  },
  info: {
    container: 'bg-blue-50 border-blue-300 text-blue-900',
    icon: 'ℹ',
  },
};

export function InlineAlert({ type, message }: Props) {
  const conf = styles[type];
  return (
    <div className={`border rounded-lg px-3.5 py-2.5 text-xs font-medium flex items-center gap-2.5 ${conf.container}`}>
      <span className="font-bold text-sm leading-none flex-shrink-0">{conf.icon}</span>
      <span>{message}</span>
    </div>
  );
}
