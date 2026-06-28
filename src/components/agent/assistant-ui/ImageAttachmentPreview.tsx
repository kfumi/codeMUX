import { useState } from 'react';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '../../../lib/utils';

type ImageAttachmentPreviewProps = {
  src: string;
  alt: string;
  thumbnailClassName?: string;
  imageClassName?: string;
};

export function ImageAttachmentPreview({
  src,
  alt,
  thumbnailClassName,
  imageClassName,
}: ImageAttachmentPreviewProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'group/image relative block overflow-hidden rounded-lg border border-border/60 bg-[hsl(var(--surface-2))] shadow-[0_10px_24px_-18px_hsl(var(--foreground)/0.5)] transition-all hover:-translate-y-0.5 hover:border-border hover:shadow-[0_18px_34px_-22px_hsl(var(--foreground)/0.58)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/55',
          thumbnailClassName,
        )}
        title="预览图片"
        aria-label={`预览图片 ${alt}`}
      >
        <img
          src={src}
          alt={alt}
          className={cn('h-full w-full object-cover transition-transform duration-200 group-hover/image:scale-[1.03]', imageClassName)}
        />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          overlayClassName="z-[250] bg-black/72 backdrop-blur-sm"
          className="z-[260] flex h-[min(88vh,54rem)] w-[min(92vw,72rem)] max-w-none items-center justify-center border-border/35 bg-black/92 p-3 shadow-[0_30px_90px_-36px_black] sm:rounded-lg"
        >
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <img
            src={src}
            alt={alt}
            className="max-h-full max-w-full rounded-md object-contain"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
