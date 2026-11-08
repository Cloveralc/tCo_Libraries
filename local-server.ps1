$ErrorActionPreference = 'Continue'
$appRoot = (Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$hostAddress = '127.0.0.1'
$port = 41731
if ($env:TCO_PORT) { $port = [int]$env:TCO_PORT }
$tokenBytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($tokenBytes)
$token = ([BitConverter]::ToString($tokenBytes)).Replace('-', '').ToLowerInvariant()
$filesById = @{}
$supported = @('txt','md','markdown','tex','latex','epub','pdf','doc','docx','png','jpg','jpeg','gif','webp','bmp','svg','avif','mp4','webm','ogv','mov','m4v','mp3','wav','ogg','oga','m4a','aac','flac','opus')
$mime = @{
 '.txt'='text/plain; charset=utf-8'; '.md'='text/markdown; charset=utf-8'; '.markdown'='text/markdown; charset=utf-8'
 '.tex'='text/plain; charset=utf-8'; '.latex'='text/plain; charset=utf-8'; '.epub'='application/epub+zip'; '.pdf'='application/pdf'
 '.doc'='application/msword'; '.docx'='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
 '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'; '.gif'='image/gif'; '.webp'='image/webp'; '.bmp'='image/bmp'; '.svg'='image/svg+xml'; '.avif'='image/avif'
 '.mp4'='video/mp4'; '.webm'='video/webm'; '.ogv'='video/ogg'; '.mov'='video/quicktime'; '.m4v'='video/x-m4v'
 '.mp3'='audio/mpeg'; '.wav'='audio/wav'; '.ogg'='audio/ogg'; '.oga'='audio/ogg'; '.m4a'='audio/mp4'; '.aac'='audio/aac'; '.flac'='audio/flac'; '.opus'='audio/ogg'
 '.html'='text/html; charset=utf-8'; '.css'='text/css; charset=utf-8'; '.js'='text/javascript; charset=utf-8'
 '.ico'='image/x-icon'; '.woff2'='font/woff2'; '.woff'='font/woff'; '.ttf'='font/ttf'
}
$crlf = [string][char]13 + [char]10

function Get-FileMime([string]$FilePath) {
 $extension=[IO.Path]::GetExtension($FilePath).ToLowerInvariant()
 if($mime.ContainsKey($extension)){return $mime[$extension]}
 return 'application/octet-stream'
}
function Send-Response($Stream,[int]$Status,[string]$ContentType,[byte[]]$Body,[hashtable]$Headers=@{}) {
 $reason=@{200='OK';206='Partial Content';400='Bad Request';403='Forbidden';404='Not Found';405='Method Not Allowed';413='Payload Too Large';416='Range Not Satisfiable';500='Internal Server Error'}
 $header='HTTP/1.1 '+$Status+' '+$reason[$Status]+$crlf
 $header+='Content-Type: '+$ContentType+$crlf
 $header+='Content-Length: '+$Body.Length+$crlf
 $header+='Connection: close'+$crlf+'Cache-Control: no-store'+$crlf+'X-Content-Type-Options: nosniff'+$crlf
 foreach($key in $Headers.Keys){$header+=$key+': '+$Headers[$key]+$crlf}
 $header+=$crlf
 $bytes=[Text.Encoding]::ASCII.GetBytes($header)
 $Stream.Write($bytes,0,$bytes.Length)
 if($Body -and $Body.Length -gt 0){$Stream.Write($Body,0,$Body.Length)}
}
function Read-HttpRequest($Stream) {
 $buffer=New-Object byte[] 8192
 $memory=New-Object IO.MemoryStream
 $headerEnd=-1
 while($headerEnd -lt 0){
  $read=$Stream.Read($buffer,0,$buffer.Length)
  if($read -le 0){$memory.Dispose();return $null}
  $memory.Write($buffer,0,$read)
  if($memory.Length -gt 65536){$memory.Dispose();return $null}
  $headerText=[Text.Encoding]::ASCII.GetString($memory.ToArray())
  $headerEnd=$headerText.IndexOf($crlf+$crlf,[StringComparison]::Ordinal)
 }
 $allBytes=$memory.ToArray()
 $headerText=[Text.Encoding]::ASCII.GetString($allBytes,0,$headerEnd)
 $lines=$headerText -split $crlf
 $requestParts=$lines[0] -split ' ',3
 if($requestParts.Count -lt 2){$memory.Dispose();return $null}
 $headers=@{}
 foreach($line in $lines | Select-Object -Skip 1){
  $separator=$line.IndexOf(':')
  if($separator -gt 0){$headers[$line.Substring(0,$separator).Trim()]=$line.Substring($separator+1).Trim()}
 }
 $bodyLength=0
 if($headers.ContainsKey('Content-Length')){[void][int]::TryParse($headers['Content-Length'],[ref]$bodyLength)}
 if($bodyLength -gt 16384){$memory.Dispose();return [pscustomobject]@{Method=$requestParts[0];Target=$requestParts[1];Headers=$headers;Body=$null;TooLarge=$true}}
 $bodyStart=$headerEnd+4
 while($memory.Length -lt ($bodyStart+$bodyLength)){
  $read=$Stream.Read($buffer,0,$buffer.Length)
  if($read -le 0){$memory.Dispose();return $null}
  $memory.Write($buffer,0,$read)
 }
 $allBytes=$memory.ToArray()
 $body=New-Object byte[] $bodyLength
 if($bodyLength -gt 0){[Array]::Copy($allBytes,$bodyStart,$body,0,$bodyLength)}
 $memory.Dispose()
 return [pscustomobject]@{Method=$requestParts[0];Target=$requestParts[1];Headers=$headers;Body=$body;TooLarge=$false}
}
function Test-ApiAuthorization($Request,$Uri,$RemoteAddress) {
 if(-not [Net.IPAddress]::IsLoopback($RemoteAddress)){return $false}
 if($Request.Headers.ContainsKey('Origin')){
  try{$origin=[Uri]$Request.Headers['Origin'];if(($origin.Host -notin @('127.0.0.1','localhost')) -or ($origin.Port -ne $port)){return $false}}catch{return $false}
 }
 $provided=[string]$Request.Headers['X-Tco-Token']
 if(-not $provided){$provided=[string]([Web.HttpUtility]::ParseQueryString($Uri.Query)['token'])}
 return [string]::Equals($provided,$token,[StringComparison]::Ordinal)
}
function Scan-Directory([string]$RequestedPath) {
 if([string]::IsNullOrWhiteSpace($RequestedPath)){throw '���ṩ�ļ��е�����·����'}
 $root=[IO.Path]::GetFullPath($RequestedPath.Trim())
 if(-not [IO.Directory]::Exists($root)){throw 'ָ��·�����ǿɶ�ȡ���ļ��С�'}
 $root=(Get-Item -LiteralPath $root -Force).FullName.TrimEnd([char[]]@('\','/'))
 $records=New-Object 'System.Collections.Generic.List[object]'
 $directories=New-Object 'System.Collections.Generic.List[string]'
 $directories.Add('')
 $pending=New-Object 'System.Collections.Generic.Stack[object]'
 $pending.Push([pscustomobject]@{Full=$root;Relative='';Depth=0})
 while($pending.Count -gt 0){
  $current=$pending.Pop()
  foreach($entry in [IO.Directory]::EnumerateFileSystemEntries($current.Full)){
   try{
    $attributes=[IO.File]::GetAttributes($entry)
    $name=[IO.Path]::GetFileName($entry)
    $relative=if($current.Relative){$current.Relative+'/'+$name}else{$name}
    if(($attributes -band [IO.FileAttributes]::Directory) -ne 0){
     $directories.Add($relative)
     if($current.Depth -lt 128){$pending.Push([pscustomobject]@{Full=$entry;Relative=$relative;Depth=$current.Depth+1})}
     continue
    }
    $extension=[IO.Path]::GetExtension($name).TrimStart('.').ToLowerInvariant()
    if($extension -notin $supported){continue}
    $info=[IO.FileInfo]::new($entry)
    $id=[Guid]::NewGuid().ToString('N')
    $filesById[$id]=[pscustomobject]@{Full=$entry;Name=$name}
    $epoch=[DateTime]::SpecifyKind([DateTime]'1970-01-01',[DateTimeKind]::Utc)
    $records.Add([pscustomobject]@{id=$id;name=$name;ext='.'+$extension;size=$info.Length;time=[long](($info.LastWriteTimeUtc-$epoch).TotalMilliseconds);path=$relative;url='/api/library/file/'+$id+'?token='+$token})
    if($records.Count -gt 200000){throw '�ļ����е���֧���ļ����� 200,000 ������ѡ���С��Ŀ¼��'}
   }catch{if($_.Exception.Message -like '�ļ����е���֧���ļ�����*'){throw}}
  }
 }
 return [pscustomobject]@{root=$root;label=[IO.Path]::GetFileName($root);files=@($records.ToArray());directories=@($directories.ToArray())}
}
function Send-ScannedFile($Stream,$Request,[string]$Id) {
 if(-not $filesById.ContainsKey($Id)){$body=[Text.Encoding]::UTF8.GetBytes('�ļ�������ʧЧ��������ִ�� load��');Send-Response $Stream 404 'text/plain; charset=utf-8' $body;return}
 $entry=$filesById[$Id]
 try{$info=[IO.FileInfo]::new($entry.Full);if(-not $info.Exists){throw 'missing'}}catch{$body=[Text.Encoding]::UTF8.GetBytes('�ļ������ڻ򲻿ɶ�ȡ��');Send-Response $Stream 404 'text/plain; charset=utf-8' $body;return}
 $length=[long]$info.Length;$start=0L;$end=$length-1;$status=200;$headers=@{'Accept-Ranges'='bytes'}
 $range=[string]$Request.Headers['Range']
 if($range){
  $match=[regex]::Match($range,'^bytes=(\d*)-(\d*)$')
  if(-not $match.Success){Send-Response $Stream 416 'text/plain; charset=utf-8' ([byte[]]@()) @{'Content-Range'="bytes */$length"};return}
  if($match.Groups[1].Value){$start=[long]$match.Groups[1].Value;if($match.Groups[2].Value){$end=[Math]::Min($length-1,[long]$match.Groups[2].Value)}}
  elseif($match.Groups[2].Value){$start=[Math]::Max(0,$length-[long]$match.Groups[2].Value)}
  if($start -lt 0 -or $end -lt $start -or $start -ge $length){Send-Response $Stream 416 'text/plain; charset=utf-8' ([byte[]]@()) @{'Content-Range'="bytes */$length"};return}
  $status=206;$headers['Content-Range']="bytes $start-$end/$length"
 }
 $count=[long]($end-$start+1);$headers['Content-Length']=[string]$count;$headers['Cache-Control']='no-store';$headers['X-Content-Type-Options']='nosniff'
 $reason=@{200='OK';206='Partial Content'}[$status]
 $header='HTTP/1.1 '+$status+' '+$reason+$crlf+'Content-Type: '+(Get-FileMime $entry.Name)+$crlf
 foreach($key in $headers.Keys){$header+=$key+': '+$headers[$key]+$crlf}
 $header+='Connection: close'+$crlf+$crlf
 $headerBytes=[Text.Encoding]::ASCII.GetBytes($header);$Stream.Write($headerBytes,0,$headerBytes.Length)
 if($Request.Method -eq 'HEAD' -or $count -le 0){return}
 $fileStream=[IO.File]::OpenRead($entry.Full)
 try{
  [void]$fileStream.Seek($start,[IO.SeekOrigin]::Begin);$buffer=New-Object byte[] 65536;$remaining=$count
  while($remaining -gt 0){$read=$fileStream.Read($buffer,0,[int][Math]::Min($buffer.Length,$remaining));if($read -le 0){break};$Stream.Write($buffer,0,$read);$remaining-=$read}
 }finally{$fileStream.Dispose()}
}
function Handle-Request($Client,$Request) {
 $stream=$Client.GetStream()
 if($Request.TooLarge){$body=[Text.Encoding]::UTF8.GetBytes('�������ݹ���');Send-Response $stream 413 'text/plain; charset=utf-8' $body;return}
 $uri=[Uri]::new('http://'+$hostAddress+':'+$port+$Request.Target)
 $remote=$Client.Client.RemoteEndPoint.Address
 if($uri.AbsolutePath.StartsWith('/api/')){
  if(-not (Test-ApiAuthorization $Request $uri $remote)){$body=[Text.Encoding]::UTF8.GetBytes('�����Ŀ����δ��Ȩ��');Send-Response $stream 403 'text/plain; charset=utf-8' $body;return}
  if($Request.Method -eq 'POST' -and $uri.AbsolutePath -eq '/api/library/scan'){
   try{$bodyText=[Text.Encoding]::UTF8.GetString($Request.Body)|ConvertFrom-Json;$result=Scan-Directory ([string]$bodyText.path);$body=[Text.Encoding]::UTF8.GetBytes(($result|ConvertTo-Json -Depth 6 -Compress));Send-Response $stream 200 'application/json; charset=utf-8' $body}
   catch{$body=[Text.Encoding]::UTF8.GetBytes((@{error=$_.Exception.Message}|ConvertTo-Json -Compress));Send-Response $stream 400 'application/json; charset=utf-8' $body}
   return
  }
  if($Request.Method -eq 'POST' -and $uri.AbsolutePath -eq '/api/library/choose'){
   try{Add-Type -AssemblyName System.Windows.Forms;$owner=New-Object System.Windows.Forms.Form;$owner.TopMost=$true;$owner.ShowInTaskbar=$false;$owner.Opacity=0;$owner.StartPosition='CenterScreen';$owner.Show();$dialog=New-Object System.Windows.Forms.FolderBrowserDialog;$dialog.Description='选择要载入的文库文件夹';$dialog.ShowNewFolderButton=$false;$dialogResult=$dialog.ShowDialog($owner);$owner.Dispose();if($dialogResult -ne [Windows.Forms.DialogResult]::OK){throw '已取消文件夹选择。'};$result=Scan-Directory $dialog.SelectedPath;$body=[Text.Encoding]::UTF8.GetBytes(($result|ConvertTo-Json -Depth 6 -Compress));Send-Response $stream 200 'application/json; charset=utf-8' $body}
   catch{$body=[Text.Encoding]::UTF8.GetBytes((@{error=$_.Exception.Message}|ConvertTo-Json -Compress));Send-Response $stream 400 'application/json; charset=utf-8' $body}
   return
  }
  if($Request.Method -eq 'POST' -and $uri.AbsolutePath -eq '/api/library/reveal'){
   try{$bodyText=[Text.Encoding]::UTF8.GetString($Request.Body)|ConvertFrom-Json;$target='';$selectFile='';$id=[string]$bodyText.fileId;$root='';if($id){if(-not $filesById.ContainsKey($id)){throw '�ļ�������ʧЧ�������������ļ��С�'};$selectFile=$filesById[$id].Full;$target=[IO.Path]::GetDirectoryName($selectFile)}elseif($bodyText.relativePath){$root=[string]$bodyText.root;if(-not $root){Add-Type -AssemblyName System.Windows.Forms;$owner=New-Object System.Windows.Forms.Form;$owner.TopMost=$true;$owner.ShowInTaskbar=$false;$owner.Opacity=0;$owner.StartPosition='CenterScreen';$owner.Show();$dialog=New-Object System.Windows.Forms.FolderBrowserDialog;$dialog.Description='Select the original folder loaded by the browser';$dialog.ShowNewFolderButton=$false;$dialogResult=$dialog.ShowDialog($owner);$owner.Dispose();if($dialogResult -ne [Windows.Forms.DialogResult]::OK){throw 'Folder selection was cancelled.'};$root=$dialog.SelectedPath};$root=(Get-Item -LiteralPath $root -ErrorAction Stop).FullName;$relative=([string]$bodyText.relativePath).TrimStart([char[]]@('\','/')).Replace('/',[IO.Path]::DirectorySeparatorChar);$selectFile=Join-Path -Path $root -ChildPath $relative;$selectFile=(Get-Item -LiteralPath $selectFile -ErrorAction Stop).FullName;$prefix=$root.TrimEnd([char[]]@('\','/'))+[IO.Path]::DirectorySeparatorChar;if(-not $selectFile.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw '�ļ�·��������ѡ�ļ��С�'};$target=[IO.Path]::GetDirectoryName($selectFile);if(-not [IO.File]::Exists($selectFile)){throw '��ѡ�ļ������Ҳ������ļ�����ȷ��ѡ���������ʱ��ԭ�ļ��С�'}}else{$inputPath=[IO.Path]::GetFullPath([string]$bodyText.path);if([IO.Directory]::Exists($inputPath)){$target=$inputPath}elseif([IO.File]::Exists($inputPath)){$selectFile=$inputPath;$target=[IO.Path]::GetDirectoryName($inputPath)}else{throw '������ļ����ļ���·�������ڡ�'}};if(-not [IO.Directory]::Exists($target)){throw 'Ŀ���ļ��в����ڡ�'};$explorer=Join-Path $env:WINDIR 'explorer.exe';$argument=if($selectFile){'/select,"'+$selectFile+'"'}else{'"'+$target+'"'};$process=[Diagnostics.Process]::Start($explorer,$argument);if(-not $process){throw 'Windows δ��������Դ��������'};$body=[Text.Encoding]::UTF8.GetBytes((@{ok=$true;root=$root}|ConvertTo-Json -Compress));Send-Response $stream 200 'application/json; charset=utf-8' $body}
   catch{$body=[Text.Encoding]::UTF8.GetBytes((@{error=$_.Exception.Message}|ConvertTo-Json -Compress));Send-Response $stream 400 'application/json; charset=utf-8' $body}
   return
  }
  if($Request.Method -in @('GET','HEAD') -and $uri.AbsolutePath -match '^/api/library/file/([0-9a-fA-F-]+)$'){Send-ScannedFile $stream $Request $Matches[1];return}
  $body=[Text.Encoding]::UTF8.GetBytes('Not found');Send-Response $stream 404 'text/plain; charset=utf-8' $body;return
 }
 if($Request.Method -notin @('GET','HEAD')){$body=[Text.Encoding]::UTF8.GetBytes('Method not allowed');Send-Response $stream 405 'text/plain; charset=utf-8' $body;return}
 $path=[Uri]::UnescapeDataString($uri.AbsolutePath)
 if($path -eq '/' -or $path -eq '/library.html'){$path='/library.html'}
 $first=($path.Trim('/').Split('/'))[0]
 if($first -ne 'assets' -and $path -ne '/library.html'){$body=[Text.Encoding]::UTF8.GetBytes('Not found');Send-Response $stream 404 'text/plain; charset=utf-8' $body;return}
 $candidate=[IO.Path]::GetFullPath((Join-Path $appRoot $path.TrimStart('/').Replace('/',[IO.Path]::DirectorySeparatorChar)))
 $prefix=$appRoot.TrimEnd([char[]]@('\','/'))+[IO.Path]::DirectorySeparatorChar
 if(-not $candidate.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){$body=[Text.Encoding]::UTF8.GetBytes('Forbidden');Send-Response $stream 403 'text/plain; charset=utf-8' $body;return}
 if(-not [IO.File]::Exists($candidate)){$body=[Text.Encoding]::UTF8.GetBytes('Not found');Send-Response $stream 404 'text/plain; charset=utf-8' $body;return}
 $body=[IO.File]::ReadAllBytes($candidate);$contentType=Get-FileMime $candidate
 if([IO.Path]::GetExtension($candidate).ToLowerInvariant() -eq '.html'){$html=[Text.Encoding]::UTF8.GetString($body).Replace('</head>','<meta name="tco-local-token" content="'+$token+'"></head>');$body=[Text.Encoding]::UTF8.GetBytes($html)}
 Send-Response $stream 200 $contentType $body
}
$listener=$null
for($attempt=0;$attempt -lt 20;$attempt++){
 try{$candidate=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$port);$candidate.Start();$listener=$candidate;break}
 catch{if($candidate){$candidate.Stop()};$port++}
}
if(-not $listener){Write-Host '�޷��������ط���Ĭ�϶˿ڼ����� 19 ���˿ھ���ռ�á�' -ForegroundColor Red;Read-Host '�� Enter �˳�';exit 1}
Write-Host ('tCo Libraries 本地服务已启动：http://'+$hostAddress+':'+$port+'/library.html') -ForegroundColor Green
Write-Host '仅监听本机回环地址；关闭此窗口即可停止服务。'
while($true){
 $client=$null
 try{$client=$listener.AcceptTcpClient();$request=Read-HttpRequest $client.GetStream();if($request){Handle-Request $client $request}}
 catch{if($_.Exception -isnot [System.IO.IOException]){Write-Host ('������ʧ�ܣ�'+$_.Exception.Message) -ForegroundColor DarkYellow}}
 finally{if($client){$client.Close()}}
}
