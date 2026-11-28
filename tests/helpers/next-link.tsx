import React from 'react';
export default function TestLink(props: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { children, ...attributes } = props;
  return <a {...attributes}>{children}</a>;
}
