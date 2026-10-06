import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes } from 'react';
import { Link, type LinkProps } from 'react-router';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'default' | 'outline' | 'secondary' | 'ghost' | 'destructive' | 'link';
export type ButtonSize = 'xs' | 'sm' | 'default' | 'icon';

const base =
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors ' +
  'disabled:pointer-events-none disabled:opacity-50 cursor-pointer no-underline [&_svg]:size-3.5 [&_svg]:shrink-0';

const variants: Record<ButtonVariant, string> = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground',
  outline: 'border border-input bg-background text-foreground shadow-[var(--shadow-xs)] hover:bg-accent hover:text-accent-foreground',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80 hover:text-secondary-foreground',
  ghost: 'text-foreground hover:bg-accent hover:text-accent-foreground',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90 hover:text-destructive-foreground',
  link: 'text-info underline-offset-4 hover:underline',
};

const sizes: Record<ButtonSize, string> = {
  xs: 'h-6 px-2 text-xs',
  sm: 'h-8 px-3 text-[13px]',
  default: 'h-9 px-4 text-sm',
  icon: 'size-8',
};

/** Class string for button-looking elements (e.g. a router <Link>). */
export function buttonClass(variant: ButtonVariant = 'default', size: ButtonSize = 'sm', className?: string): string {
  return cn(base, variants[variant], sizes[size], className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'sm', className, type = 'button', ...rest },
  ref,
) {
  return <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...rest} />;
});

/** Router link styled as a button. */
export function ButtonLink({ variant = 'outline', size = 'sm', className, ...rest }: LinkProps & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <Link className={buttonClass(variant, size, className)} {...rest} />;
}

/** Plain anchor (downloads, external) styled as a button. */
export function ButtonAnchor({ variant = 'outline', size = 'sm', className, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <a className={buttonClass(variant, size, className)} {...rest} />;
}
