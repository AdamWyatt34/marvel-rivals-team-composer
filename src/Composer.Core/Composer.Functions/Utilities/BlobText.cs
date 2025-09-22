using System.IO.Compression;
using System.Text;
using Azure.Storage.Blobs;

namespace Composer.Functions.Utilities;

public static class BlobText
{
    public static async Task<string> DownloadTextMaybeGzipAsync(BlobContainerClient containerClient, BlobClient blob, CancellationToken ct)
    {
        // try .json.gz (same base name + ".gz")
        var name = blob.Name;
        var gzName = name.EndsWith(".gz", StringComparison.OrdinalIgnoreCase) ? name : name + ".gz";
        var gzBlob = containerClient.GetBlobClient(gzName);

        if (await gzBlob.ExistsAsync(ct))
        {
            var bin = (await gzBlob.DownloadContentAsync(ct)).Value.Content.ToMemory().ToArray();
            using var ms = new MemoryStream(bin);
            await using var gz = new GZipStream(ms, CompressionMode.Decompress);
            using var sr = new StreamReader(gz, Encoding.UTF8);
            return await sr.ReadToEndAsync(ct);
        }

        // fallback to plain
        var txt = (await blob.DownloadContentAsync(ct)).Value.Content.ToString();
        return txt;
    }
}