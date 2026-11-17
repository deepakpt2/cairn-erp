import Link from 'next/link';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, ComponentProps } from 'react';

import { cn } from './cn';

/**
 * The one button. Variants map onto the `.btn-*` rules in globals.css, so a page that still writes
 * `btn btn-default` looks the same as one that uses this component. Touch height is 44px on a
 * phone and the compact desktop size from `md` up.
 */
export const buttonVariants = cva('btn max-md:min-h-11 justify-center', {
  variants: {
    variant: { primary: 'btn-primary', default: 'btn-default', danger: 'btn-danger' },
    size: { md: '', sm: 'px-2 py-1 text-xs', icon: 'px-2 max-md:min-w-11' },
  },
  defaultVariants: { variant: 'default', size: 'md' },
});

type Variants = VariantProps<typeof buttonVariants>;

export function Button({ variant, size, className, type = 'button', ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & Variants) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...rest} />;
}

export function LinkButton({ variant, size, className, ...rest }:
  ComponentProps<typeof Link> & Variants) {
  return <Link className={cn(buttonVariants({ variant, size }), className)} {...rest} />;
}
