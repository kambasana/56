/**
 * The shadcn/ui Button (components/ui/button.tsx), plus router-link and anchor variants
 * rendered through `asChild` so they share its styles and focus ring.
 */
import type { AnchorHTMLAttributes, ComponentProps } from 'react';
import type { VariantProps } from 'class-variance-authority';
import { Link, type LinkProps } from 'react-router';
import { Button as UiButton, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Variants = VariantProps<typeof buttonVariants>;
export type ButtonVariant = NonNullable<Variants['variant']>;
export type ButtonSize = NonNullable<Variants['size']>;

export type ButtonProps = ComponentProps<typeof UiButton>;

/**
 * shadcn Button. Defaults to size "sm" (the dense app toolbar size) and type="button", so a
 * button inside a form only submits when it says so.
 */
export function Button({ size = 'sm', type, asChild, ...props }: ButtonProps) {
  return <UiButton size={size} asChild={asChild} type={asChild ? type : (type ?? 'button')} {...props} />;
}

export { buttonVariants };

/** Class string for button-looking elements. */
export function buttonClass(variant: ButtonVariant = 'default', size: ButtonSize = 'sm', className?: string): string {
  return cn(buttonVariants({ variant, size }), className);
}

/** Router link styled as a button. */
export function ButtonLink({ variant = 'outline', size = 'sm', className, ...rest }: LinkProps & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <UiButton asChild variant={variant} size={size} className={className}>
      <Link {...rest} />
    </UiButton>
  );
}

/** Plain anchor (downloads, external) styled as a button. */
export function ButtonAnchor({ variant = 'outline', size = 'sm', className, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <UiButton asChild variant={variant} size={size} className={className}>
      <a {...rest} />
    </UiButton>
  );
}
