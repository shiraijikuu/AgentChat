# Build the app icon with System.Drawing. No third-party dependencies.
# Output: build/icon.ico (multi-size), build/icon.png (256 preview)
# Usage: powershell -ExecutionPolicy Bypass -File build\make-icon.ps1

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$outDir = Join-Path $root 'build'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    if ($d -gt $w) { $d = $w }
    if ($d -gt $h) { $d = $h }
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc(($x + $w - $d), $y, $d, $d, 270, 90)
    $p.AddArc(($x + $w - $d), ($y + $h - $d), $d, $d, 0, 90)
    $p.AddArc($x, ($y + $h - $d), $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

function New-Pt([single]$x, [single]$y) {
    return (New-Object System.Drawing.PointF($x, $y))
}

function New-IconBitmap([int]$s) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # base plate: dark rounded square with a diagonal gradient
    $pad = $s * 0.02
    $bgPath = New-RoundedPath $pad $pad ($s - $pad * 2) ($s - $pad * 2) ($s * 0.22)
    $rect = New-Object System.Drawing.RectangleF(0, 0, $s, $s)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(255, 26, 36, 54), [System.Drawing.Color]::FromArgb(255, 12, 17, 26), 55.0)
    $g.FillPath($brush, $bgPath)
    $brush.Dispose()

    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 246, 249, 255))
    $blue = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 59, 130, 246))
    $ink = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 12, 17, 26))

    # big bubble, white, with a small tail
    $bx = $s * 0.14
    $by = $s * 0.19
    $bw = $s * 0.57
    $bh = $s * 0.39
    $b1 = New-RoundedPath $bx $by $bw $bh ($s * 0.11)
    $g.FillPath($white, $b1)
    $tail1 = New-Object System.Drawing.Drawing2D.GraphicsPath
    $pts1 = New-Object 'System.Drawing.PointF[]' 3
    $pts1[0] = New-Pt ($bx + $bw * 0.16) ($by + $bh - $s * 0.02)
    $pts1[1] = New-Pt ($bx + $bw * 0.16) ($by + $bh + $s * 0.14)
    $pts1[2] = New-Pt ($bx + $bw * 0.50) ($by + $bh - $s * 0.02)
    $tail1.AddPolygon($pts1)
    $g.FillPath($white, $tail1)

    # small bubble, blue, overlapping bottom right. stroke first so the edge reads
    $sx = $s * 0.44
    $sy = $s * 0.45
    $sw = $s * 0.43
    $sh = $s * 0.32
    $b2 = New-RoundedPath $sx $sy $sw $sh ($s * 0.10)
    $penW = [Math]::Max(1.0, $s * 0.05)
    $outline = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 15, 21, 32), $penW)
    $g.DrawPath($outline, $b2)
    $g.FillPath($blue, $b2)
    $tail2 = New-Object System.Drawing.Drawing2D.GraphicsPath
    $pts2 = New-Object 'System.Drawing.PointF[]' 3
    $pts2[0] = New-Pt ($sx + $sw * 0.68) ($sy + $sh - $s * 0.01)
    $pts2[1] = New-Pt ($sx + $sw * 0.94) ($sy + $sh + $s * 0.12)
    $pts2[2] = New-Pt ($sx + $sw * 0.40) ($sy + $sh - $s * 0.01)
    $tail2.AddPolygon($pts2)
    $g.FillPath($blue, $tail2)

    # three dots inside the white bubble. skip on tiny sizes, they turn to mush
    if ($s -ge 32) {
        $dr = $s * 0.042
        $gap = $s * 0.118
        $cy = $by + $bh * 0.47
        $cx = $bx + $bw * 0.5 - $gap
        for ($i = 0; $i -lt 3; $i++) {
            $dx = $cx + $i * $gap - $dr
            $g.FillEllipse($blue, $dx, ($cy - $dr), ($dr * 2), ($dr * 2))
        }
    }

    $white.Dispose()
    $blue.Dispose()
    $ink.Dispose()
    $outline.Dispose()
    $b1.Dispose()
    $b2.Dispose()
    $bgPath.Dispose()
    $tail1.Dispose()
    $tail2.Dispose()
    $g.Dispose()
    return $bmp
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngData = @()
foreach ($s in $sizes) {
    $bmp = New-IconBitmap $s
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngData += , ($ms.ToArray())
    if ($s -eq 256) {
        $bmp.Save((Join-Path $outDir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    }
    $ms.Dispose()
    $bmp.Dispose()
}

# ICO container: 6 byte header, 16 byte entry per image, then PNG payloads
$icoPath = Join-Path $outDir 'icon.ico'
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$sizes.Count)

$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]
    $len = $pngData[$i].Length
    $dim = $s
    if ($s -ge 256) { $dim = 0 }
    $bw.Write([Byte]$dim)
    $bw.Write([Byte]$dim)
    $bw.Write([Byte]0)
    $bw.Write([Byte]0)
    $bw.Write([UInt16]1)
    $bw.Write([UInt16]32)
    $bw.Write([UInt32]$len)
    $bw.Write([UInt32]$offset)
    $offset += $len
}
foreach ($d in $pngData) { $bw.Write($d) }
$bw.Flush()
$bw.Close()
$fs.Close()

$size = (Get-Item $icoPath).Length
Write-Output ("icon.ico written, {0} bytes, {1} sizes" -f $size, $sizes.Count)
