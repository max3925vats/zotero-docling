menuitem-convert = Convert with Docling
menuitem-reconvert = Re-convert with Docling (replace)
menuitem-export-md-zip = Export markdown to .zip
menuitem-tools-export-md-zip = Docling: Export markdown to .zip…
menuitem-remove-images = Remove images from markdown
menuitem-tools-remove-images = Docling: Remove images from markdown…
pref-pane-label = zotero-docling

## Shared
confirm-dont-ask-again = Don't ask again
busy-auto-convert = Auto-convert is running (or checking the server) — try again in a moment
busy-remove-images = Remove Images is running — try again in a moment
busy-batch = A conversion batch is already running — wait for it to finish

## Convert / Re-convert
reconvert-confirm-title = Re-convert with Docling?
reconvert-confirm-button = Re-convert
reconvert-confirm-body-replace =
    { $count ->
        [one] This will convert the selected PDF again and replace its markdown attachment. The old markdown is moved to the Zotero trash once the new one is attached, and is kept if conversion fails.
       *[other] This will convert { $count } selected PDFs again and replace their markdown attachments. The old markdown is moved to the Zotero trash once the new one is attached, and is kept if conversion fails.
    }
reconvert-confirm-body-export =
    { $count ->
        [one] This will convert the selected PDF again and write the result to your export folder. "Attach to item" is off, so the existing markdown attachment in Zotero is kept as-is.
       *[other] This will convert { $count } selected PDFs again and write the results to your export folder. "Attach to item" is off, so the existing markdown attachments in Zotero are kept as-is.
    }
toast-no-md-to-replace = No matching .md files to replace in selection
toast-no-pdfs = No PDF attachments in selection
toast-server-not-running = docling-serve isn't running — start it and retry
toast-batch-failed = Batch failed: { $message }

## Auto-convert
autoconvert-title = Docling auto-convert
autoconvert-queued =
    { $count ->
        [one] Queued 1 PDF — will start after the current batch finishes
       *[other] Queued { $count } PDFs — will start after the current batch finishes
    }
autoconvert-retrying =
    { $count ->
        [one] docling-serve isn't running — will retry 1 PDF for a few minutes
       *[other] docling-serve isn't running — will retry { $count } PDFs for a few minutes
    }
autoconvert-gave-up =
    { $count ->
        [one] Skipped 1 PDF — docling-serve still isn't running
       *[other] Skipped { $count } PDFs — docling-serve still isn't running
    }

## Remove images
remove-images-confirm-title = Remove images from markdown?
remove-images-confirm-body =
    { $count ->
        [one] This rewrites the selected markdown attachment in place, replacing every embedded image with a small <!-- image --> placeholder.
       *[other] This rewrites { $count } markdown attachments in place, replacing every embedded image with a small <!-- image --> placeholder.
    }
remove-images-confirm-warning = The image data is removed for good — re-convert the PDF if you ever want it back.
remove-images-confirm-button = Remove images
remove-images-select-first = Select items with converted markdown (or .md attachments) first.
remove-images-done =
    { $images ->
        [one] Replaced 1 image
       *[other] Replaced { $images } images
    } in { $files ->
        [one] 1 file
       *[other] { $files } files
    }, saving { $saved }
remove-images-none =
    { $count ->
        [one] No images found in 1 markdown file
       *[other] No images found in { $count } markdown files
    }
remove-images-untouched = { $count } had no images
remove-images-failed = { $count } failed

## Export markdown to .zip
zip-missing-title = Export markdown to .zip
zip-missing-body = { $missing } of { $total } selected PDFs have no Docling markdown yet.
zip-missing-question = How would you like to proceed?
zip-skip-and-export = Skip and export
zip-convert-first = Convert first
zip-select-first = Select one or more items (or PDF attachments) to export.
zip-no-parents = Selected PDFs have no parent items — cannot export.
zip-nothing-converted = Conversion produced no markdown — nothing to export.
zip-building =
    { $count ->
        [one] Building zip with 1 item…
       *[other] Building zip with { $count } items…
    }
zip-exported =
    { $count ->
        [one] Exported 1 markdown file to { $path }
       *[other] Exported { $count } markdown files to { $path }
    }
zip-skipped-no-md = { $count } skipped (no .md)
zip-unreadable = { $count } unreadable
zip-build-failed = Failed to build zip: { $message }
zip-write-failed = Failed to write zip: { $message }
zip-replace-title = Replace existing file?
zip-replace-body = { $name } already exists. Replace it?
