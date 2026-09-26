"use client";

import { useRef, cloneElement, useMemo, useCallback, createContext, useContext, useState } from "react";
import { useConfig } from "@/contexts/config-context";
import { getUploadFileName, joinPathSegments } from "@/lib/utils/file";
import { toast } from "sonner";
import { getSchemaByName } from "@/lib/schema";
import { cn } from "@/lib/utils";
import { requireApiSuccess } from "@/lib/api-client";
import type { FileSaveData } from "@/types/api";

interface MediaUploadContextValue {
  handleFiles: (files: File[]) => Promise<void>;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
}

const MediaUploadContext = createContext<MediaUploadContextValue | null>(null);

interface MediaUploadProps {
  children: React.ReactNode;
  path?: string;
  onUpload?: (entry: FileSaveData) => void;
  media?: string;
  extensions?: string[];
  multiple?: boolean;
  rename?: boolean | "safe" | "random";
  disabled?: boolean;
}

interface MediaUploadTriggerProps {
  children: React.ReactElement<{ onClick?: () => void }>;
}

interface MediaUploadDropZoneProps {
  children: React.ReactNode;
  className?: string;
}

// Keep each request under typical serverless body limits (e.g. 4.5 MB on
// Vercel); base64 adds ~33% to the file size.
const MAX_BATCH_BYTES = 3 * 1024 * 1024;
const MAX_BATCH_FILES = 20;

const groupUploadBatches = <T extends { file: File }>(items: T[]): T[][] => {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;

  for (const item of items) {
    const bytes = Math.ceil(item.file.size * 4 / 3);
    if (bytes > MAX_BATCH_BYTES) {
      batches.push([item]);
      continue;
    }
    if (current.length > 0 && (currentBytes + bytes > MAX_BATCH_BYTES || current.length >= MAX_BATCH_FILES)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);

  return batches;
};

function MediaUploadRoot({ children, path, onUpload, media, extensions, multiple, rename, disabled = false }: MediaUploadProps) {
  const { config } = useConfig();
  if (!config) throw new Error(`Configuration not found.`);

  const configMedia = useMemo(() => 
    media
      ? getSchemaByName(config.object, media, "media")
      : config.object.media[0],
    [media, config.object]
  );

  const accept = useMemo(() => {
    if (!configMedia?.extensions && !extensions) return undefined;
    
    const allowedExtensions = extensions 
      ? configMedia?.extensions
        ? extensions.filter(ext => configMedia.extensions.includes(ext))
        : extensions
      : configMedia?.extensions;

    return allowedExtensions?.length > 0
      ? allowedExtensions.map((extension: string) => `.${extension}`).join(",")
      : undefined;
  }, [extensions, configMedia?.extensions]);

  const handleFiles = useCallback(async (files: File[]) => {
    const readAsBase64 = (file: File) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).replace(/^(.+,)/, ""));
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });

    const uploadFile = async (file: File, filename: string): Promise<FileSaveData[]> => {
      const content = await readAsBase64(file);
      const fullPath = joinPathSegments([path ?? "", filename]);
      const response = await fetch(`/api/${config.owner}/${config.repo}/${encodeURIComponent(config.branch)}/files/${encodeURIComponent(fullPath)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "media",
          name: configMedia.name,
          content,
        }),
      });
      const data = await requireApiSuccess<any>(response, "Failed to upload file");
      return [data.data as FileSaveData];
    };

    const uploadBatch = async (batch: { file: File; filename: string }[]): Promise<FileSaveData[]> => {
      const contents = await Promise.all(batch.map(({ file }) => readAsBase64(file)));
      const response = await fetch(`/api/${config.owner}/${config.repo}/${encodeURIComponent(config.branch)}/media/${encodeURIComponent(configMedia.name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: path ?? "",
          files: batch.map(({ filename }, index) => ({ name: filename, content: contents[index] })),
        }),
      });
      const data = await requireApiSuccess<any>(response, "Failed to upload files");
      return data.data as FileSaveData[];
    };

    const batches = groupUploadBatches(files.map((file) => ({
      file,
      filename: getUploadFileName(file.name, rename ?? configMedia?.rename),
    })));

    // Batches run one after another: each one is a commit on the same branch.
    for (const batch of batches) {
      const uploadPromise = batch.length === 1
        ? uploadFile(batch[0].file, batch[0].filename)
        : uploadBatch(batch);

      toast.promise(uploadPromise, {
        loading: batch.length === 1 ? `Uploading ${batch[0].file.name}` : `Uploading ${batch.length} files`,
        success: (savedEntries) => {
          savedEntries.forEach((entry) => onUpload?.(entry));
          return batch.length === 1 ? `Uploaded ${batch[0].file.name}` : `Uploaded ${batch.length} files`;
        },
        error: (error: unknown) => error instanceof Error ? error.message : "Upload failed",
      });

      try {
        await uploadPromise;
      } catch (error) {
        console.error(error);
      }
    }
  }, [config, path, configMedia?.name, configMedia?.rename, onUpload, rename]);

  const contextValue = useMemo(() => ({
    handleFiles,
    accept,
    multiple,
    disabled,
  }), [handleFiles, accept, multiple, disabled]);

  return (
    <MediaUploadContext.Provider value={contextValue}>
      {children}
    </MediaUploadContext.Provider>
  );
}

function MediaUploadTrigger({ children }: MediaUploadTriggerProps) {
  const context = useContext(MediaUploadContext);
  if (!context) throw new Error("MediaUploadTrigger must be used within a MediaUpload component");
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const filterAcceptedFiles = useCallback((files: File[]) => {
    const acceptedExtensions = context.accept?.split(",").map((ext) => ext.trim().toLowerCase());
    if (!acceptedExtensions?.length) return files;

    const validFiles = files.filter((file) => {
      const ext = `.${file.name.split(".").pop()?.toLowerCase()}`;
      return acceptedExtensions.includes(ext);
    });

    if (validFiles.length === 0) {
      toast.error(`Invalid file type. Allowed: ${context.accept}`);
      return [];
    }

    if (validFiles.length !== files.length) {
      toast.error(`Some files were skipped. Allowed: ${context.accept}`);
    }

    return validFiles;
  }, [context.accept]);

  const handleClick = useCallback(() => {
    if (context.disabled) return;
    fileInputRef.current?.click();
  }, [context.disabled]);

  const handleFileInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    if (context.disabled) return;
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const validFiles = filterAcceptedFiles(Array.from(files));
    if (validFiles.length === 0) return;

    context.handleFiles(validFiles);
  }, [context, filterAcceptedFiles]);

  return (
    <>
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileInput}
        accept={context.accept}
        multiple={context.multiple}
        hidden
      />
      {cloneElement(children, { onClick: handleClick })}
    </>
  );
}

function MediaUploadDropZone({ children, className }: MediaUploadDropZoneProps) {
  const context = useContext(MediaUploadContext);
  if (!context) throw new Error("MediaUploadDropZone must be used within a MediaUpload component");
  
  const [isDragging, setIsDragging] = useState(false);

  const filterAcceptedFiles = useCallback((files: File[]) => {
    const acceptedExtensions = context.accept?.split(",").map((ext) => ext.trim().toLowerCase());
    if (!acceptedExtensions?.length) return files;

    const validFiles = files.filter((file) => {
      const ext = `.${file.name.split(".").pop()?.toLowerCase()}`;
      return acceptedExtensions.includes(ext);
    });

    if (validFiles.length === 0) {
      toast.error(`Invalid file type. Allowed: ${context.accept}`);
      return [];
    }

    if (validFiles.length !== files.length) {
      toast.error(`Some files were skipped. Allowed: ${context.accept}`);
    }

    return validFiles;
  }, [context.accept]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (context.disabled) return;
    e.preventDefault();
    setIsDragging(true);
  }, [context.disabled]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (context.disabled) return;
    e.preventDefault();
    setIsDragging(false);
  }, [context.disabled]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (context.disabled) return;
    e.preventDefault();
    setIsDragging(false);
    
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    const validFiles = filterAcceptedFiles(Array.from(files));
    if (validFiles.length === 0) return;

    context.handleFiles(validFiles);
  }, [context, filterAcceptedFiles]);

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn("relative", className)}
    >
      {children}
      {!context.disabled && isDragging && (
        <div className="absolute inset-0 bg-primary/10 rounded-lg flex items-center justify-center">
          <p className="text-sm text-foreground font-medium bg-background rounded-full px-3 py-1">
            Drop files here to upload
          </p>
        </div>
      )}
    </div>
  );
}

export const MediaUpload = Object.assign(MediaUploadRoot, {
  Trigger: MediaUploadTrigger,
  DropZone: MediaUploadDropZone,
});
