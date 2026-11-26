import type { Metadata } from 'next';
import './globals.css';
import { workbenchBrand, workbenchTitle } from '@/lib/workbench/brand';
import { themeBootstrap } from '@/lib/workbench/theme';

export const metadata: Metadata = {
  title: workbenchTitle,
  applicationName: workbenchBrand.name,
  icons: { icon: { url: workbenchBrand.icon, type: 'image/svg+xml' } },
  description: '制作角色动画、交互物和图片局部调整，保存草稿并从制作记录继续。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" data-theme="dark" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeBootstrap }} /></head>
      <body>{children}</body>
    </html>
  );
}
