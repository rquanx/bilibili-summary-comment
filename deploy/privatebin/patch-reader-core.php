<?php
// Add presentation selection only; encryption and upload stay upstream.
$source = file_get_contents('/var/www/js/privatebin.js');
$needle = 'CryptTool.base58encode(data.encryptionKey),';
if (substr_count($source, $needle) !== 1) {
    throw new RuntimeException('Pinned PrivateBin link builder changed; review patch');
}
$source = str_replace($needle, 'CryptTool.base58encode(data.encryptionKey) + window.PrivateBinReader.shareSuffix(),', $source);
file_put_contents('/var/www/js/privatebin-reader-core.js', $source);
