/**
 * Local session-log scrub. The engine writes what the person typed to the
 * session's .jsonl before any hook runs (queue-operation and last-prompt
 * records). After a review that redacted values, those records are patched
 * in place: each value becomes the same number of `*`, so byte offsets and
 * JSON structure are untouched and a concurrent append cannot be harmed.
 * Conversation messages are never touched; they already hold placeholders.
 */

const MARKERS = ['"type":"queue-operation"', '"type":"last-prompt"'] as const

/** A value as it appears inside a JSON string in the log (quotes and backslashes escaped). */
export function jsonNeedle(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

const stars = (n: number) => '*'.repeat(n)

/** Pure: patches the record lines of `content`; used for the fs fallback and to specify the child scripts. */
export function patchRecords(content: string, values: string[]): { text: string; patched: number } {
  const needles = [...new Set(values.map(jsonNeedle).filter(Boolean))].sort((a, b) => b.length - a.length)
  if (needles.length === 0) return { text: content, patched: 0 }
  let patched = 0
  const lines = content.split('\n').map(line => {
    if (!MARKERS.some(m => line.includes(m))) return line
    let out = line
    for (const n of needles) out = out.split(n).join(stars(n.length))
    if (out !== line) patched++
    return out
  })
  return { text: lines.join('\n'), patched }
}

const b64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin)
}

export type Platform = 'windows' | 'posix'

/**
 * The child process that patches `path` in place. Path and needles travel
 * base64-encoded so no value appears on a command line; both scripts work on
 * raw bytes (Latin-1 view in PowerShell, :raw in perl) and print the number
 * of record lines patched.
 */
export function scrubArgv(platform: Platform, path: string, values: string[]): string[] {
  const needles = [...new Set(values.map(jsonNeedle).filter(Boolean))].sort((a, b) => b.length - a.length)
  const P = b64(path)
  const N = needles.map(b64).join(',')
  if (platform === 'windows') {
    const script = [
      "$ErrorActionPreference='Stop'",
      '$enc=[Text.Encoding]::GetEncoding(28591)',
      `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${P}'))`,
      `$ns=@('${N}'.Split(',')|%{ $enc.GetString([Convert]::FromBase64String($_)) })`,
      `$marks=@('${MARKERS[0]}','${MARKERS[1]}')`,
      '$fs=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite)',
      'try {',
      '$len=[int]$fs.Length; $b=New-Object byte[] $len; $r=0',
      'while($r -lt $len){ $n=$fs.Read($b,$r,$len-$r); if($n -le 0){break}; $r+=$n }',
      '$s=$enc.GetString($b,0,$r); $count=0; $pos=0',
      'while($pos -lt $s.Length){',
      '$nl=$s.IndexOf([char]10,$pos); if($nl -lt 0){$nl=$s.Length}',
      '$line=$s.Substring($pos,$nl-$pos); $hit=$false; $isRec=$false',
      'foreach($m in $marks){ if($line.Contains($m)){ $isRec=$true } }',
      'if($isRec){ foreach($n in $ns){ if($n.Length -eq 0){continue}; $i=0',
      'while(($i=$line.IndexOf($n,$i,[StringComparison]::Ordinal)) -ge 0){',
      '[void]$fs.Seek($pos+$i,[IO.SeekOrigin]::Begin); $fill=[byte[]]::new($n.Length); for($k=0;$k -lt $fill.Length;$k++){$fill[$k]=42}',
      '$fs.Write($fill,0,$fill.Length); $i+=$n.Length; $hit=$true } } }',
      'if($hit){$count++}; $pos=$nl+1 }',
      '$fs.Flush(); Write-Output $count',
      '} finally { $fs.Dispose() }',
    ].join('; ')
    return ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]
  }
  const perl = String.raw`use MIME::Base64; my($pb,$nb)=@ARGV; my $p=decode_base64($pb); my @n=grep{length}map{decode_base64($_)}split(/,/,$nb);
open(my $fh,'+<:raw',$p) or exit 2; local $/; my $s=<$fh>; my $c=0; my $pos=0; my $L=length($s);
while($pos<$L){ my $nl=index($s,"\n",$pos); $nl=$L if $nl<0; my $line=substr($s,$pos,$nl-$pos);
 if(index($line,'"type":"queue-operation"')>=0 || index($line,'"type":"last-prompt"')>=0){ my $hit=0;
  for my $n(@n){ my $i=0; while(($i=index($line,$n,$i))>=0){ seek($fh,$pos+$i,0); print $fh ('*' x length($n)); $i+=length($n); $hit=1 } }
  $c++ if $hit }
 $pos=$nl+1 }
close($fh); print $c;`
  return ['perl', '-e', perl, P, N]
}
