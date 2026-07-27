# decode-rom.ps1 -- extracts the data tables from Adventure (1978).bin
#
# The ROM is a 4KB non-bankswitched Atari 2600 cartridge mapped at $F000-$FFFF.
# Everything this script knows about the table layouts was derived by hand from
# the 6502 code; see ANALYSIS.md for the reasoning and the address citations.
#
# Usage:   pwsh -File tools/decode-rom.ps1 [-Bitmaps] [-OutDir data]
#   -Bitmaps  also dump every room bitmap and object sprite as ASCII art to
#             stdout (useful when you need pixel-exact reference; deliberately
#             NOT written into data/ by default).

param(
  [string]$RomPath = "$PSScriptRoot\..\Adventure (1978).bin",
  [string]$OutDir  = "$PSScriptRoot\..\data",
  [switch]$Bitmaps
)

$rom = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $RomPath))
if ($rom.Length -ne 4096) { throw "expected a 4096-byte ROM, got $($rom.Length)" }
function Pk([int]$addr) { return $rom[$addr - 0xF000] }
function Hex([int]$v, [int]$w = 2) { return ('{0:X' + $w + '}') -f $v }

# ---------------------------------------------------------------- constants --
$ROOM_BASE   = 0xFE1B   # 9-byte records
$ROOM_COUNT  = 31       # $00-$1E; $1F/$20 are table garbage
$OBJ_BASE    = 0xFF44   # 9-byte records; object "code" == byte offset from base
$OBJ_COUNT   = 19
$VAREXIT_TBL = 0xFF32   # exit >= $80 -> table[(exit-$80) + gameNumber]
$LAYOUT_PTRS = 0xF45A   # 3 pointers (games 1,2,3) to 49-byte ZP images
$RANDOM_TBL  = 0xF439   # game 3: 3-byte entries {zpAddr, minRoom, maxRoom}
$ZP_BASE     = 0xA1     # layout images are copied to $00A1..$00D1

$roomNames = @{
  0x00='select-screen';       0x01='overworld-nw';        0x02='overworld-n'
  0x03='overworld-ne';        0x04='blue-maze-1';         0x05='blue-maze-2'
  0x06='blue-maze-3';         0x07='blue-maze-4';         0x08='blue-maze-5'
  0x09='catacomb-1';          0x0A='catacomb-2';          0x0B='catacomb-3'
  0x0C='overworld-sw';        0x0D='overworld-s';         0x0E='overworld-se'
  0x0F='white-castle';        0x10='black-castle';        0x11='gold-castle'
  0x12='gold-castle-keep';    0x13='black-maze-1';        0x14='black-maze-2'
  0x15='black-maze-3';        0x16='black-maze-4';        0x17='white-maze-1'
  0x18='white-maze-2';        0x19='white-maze-3';        0x1A='white-maze-entry'
  0x1B='black-castle-hall';   0x1C='overworld-w';         0x1D='overworld-e'
  0x1E='credits-room'
}

$objNames = @{
  0x00='surround';        0x09='portcullis-gold'; 0x12='portcullis-white'
  0x1B='portcullis-black';0x24='credits-text';    0x2D='game-number'
  0x36='dragon-rhindle';  0x3F='dragon-yorgle';   0x48='dragon-grundle'
  0x51='sword';           0x5A='bridge';          0x63='key-gold'
  0x6C='key-white';       0x75='key-black';       0x7E='bat'
  0x87='dot';             0x90='chalice';         0x99='magnet'
  0xA2='null'
}

# ------------------------------------------------------------------- rooms --
function PfRow([int]$pf0, [int]$pf1, [int]$pf2) {
  $s = ''
  for ($b = 4; $b -le 7; $b++) { $s += $(if ($pf0 -band (1 -shl $b)) { '#' } else { '.' }) }
  for ($b = 7; $b -ge 0; $b--) { $s += $(if ($pf1 -band (1 -shl $b)) { '#' } else { '.' }) }
  for ($b = 0; $b -le 7; $b++) { $s += $(if ($pf2 -band (1 -shl $b)) { '#' } else { '.' }) }
  return $s
}

$rooms = @()
for ($n = 0; $n -lt $ROOM_COUNT; $n++) {
  $a     = $ROOM_BASE + 9 * $n
  $gfx   = (Pk($a + 1)) * 256 + (Pk $a)
  $ctrl  = Pk($a + 4)
  $mirror = [bool]($ctrl -band 1)
  $grid  = @()
  for ($row = 0; $row -lt 7; $row++) {
    $o    = $gfx + $row * 3
    $half = PfRow (Pk $o) (Pk($o + 1)) (Pk($o + 2))
    if ($mirror) {
      $c = $half.ToCharArray(); [array]::Reverse($c); $grid += ($half + (-join $c))
    } else {
      $grid += ($half + $half)
    }
  }
  $rooms += [ordered]@{
    id          = Hex $n
    name        = $roomNames[$n]
    addr        = Hex $a 4
    gfxAddr     = Hex $gfx 4
    color       = Hex (Pk($a + 2))     # used when the COLOR/BW switch is on COLOR
    colorBW     = Hex (Pk($a + 3))
    ctrlpf      = Hex $ctrl
    mirrored    = $mirror              # false => left half is REPEATED, not mirrored
    ballSize    = (($ctrl -band 0x30) -shr 4)
    exits       = [ordered]@{ up = Hex (Pk($a + 5)); right = Hex (Pk($a + 6)); down = Hex (Pk($a + 7)); left = Hex (Pk($a + 8)) }
    walls       = $grid                # 7 strings x 40 chars, '#' = solid
  }
}

# ----------------------------------------------------------------- objects --
$objects = @()
for ($k = 0; $k -lt $OBJ_COUNT; $k++) {
  $a    = $OBJ_BASE + 9 * $k
  $code = 9 * $k
  $pos  = (Pk($a + 1)) * 256 + (Pk $a)
  $stp  = (Pk($a + 3)) * 256 + (Pk($a + 2))
  $tbl  = (Pk($a + 5)) * 256 + (Pk($a + 4))

  # walk the state -> sprite table: 3-byte entries {maxState, gfxLo, gfxHi}
  $frames = @(); $y = $tbl
  for ($i = 0; $i -lt 16; $i++) {
    $thr = Pk $y
    $gp  = (Pk($y + 2)) * 256 + (Pk($y + 1))
    $h = 0; while ((Pk($gp + $h)) -ne 0 -and $h -lt 32) { $h++ }
    $frames += [ordered]@{ maxState = Hex $thr; gfxAddr = Hex $gp 4; height = $h }
    if ($thr -eq 0xFF) { break }
    $y += 3
  }

  $o = [ordered]@{
    code        = Hex $code
    name        = $objNames[$code]
    addr        = Hex $a 4
    statePtr    = Hex $stp 4
    gfxTable    = Hex $tbl 4
    color       = Hex (Pk($a + 6))
    colorBW     = Hex (Pk($a + 7))
    nusiz       = Hex (Pk($a + 8))     # 07 = quadruple width
    frames      = $frames
  }
  if ($pos -ge 0xF000) {
    $o.positionKind  = 'fixed'
    $o.fixedPosition = [ordered]@{ room = Hex (Pk $pos); x = Hex (Pk($pos + 1)); y = Hex (Pk($pos + 2)) }
  } else {
    $o.positionKind = 'ram'
    $o.zpPosition   = Hex $pos          # room, x, y at this zero-page address
  }
  if ($stp -ge 0xF000) { $o.stateKind = 'constant'; $o.constState = Hex (Pk $stp) }
  else                 { $o.stateKind = 'ram' }
  $objects += $o
}

# ------------------------------------------------------------------ layouts --
# The layout image is a byte-for-byte copy of $00A1..$00D1. Object records
# above tell us which zero-page address belongs to which object; dragons
# occupy 5 bytes (room,x,y,pad,state) so the image is NOT a uniform stride.
$slots = @(
  @{ zp = 0xA1; span = 3; owner = 'dot' }
  @{ zp = 0xA4; span = 5; owner = 'dragon-rhindle' }
  @{ zp = 0xA9; span = 5; owner = 'dragon-yorgle' }
  @{ zp = 0xAE; span = 5; owner = 'dragon-grundle' }
  @{ zp = 0xB3; span = 3; owner = 'magnet' }
  @{ zp = 0xB6; span = 3; owner = 'sword' }
  @{ zp = 0xB9; span = 3; owner = 'chalice' }
  @{ zp = 0xBC; span = 3; owner = 'bridge' }
  @{ zp = 0xBF; span = 3; owner = 'key-gold' }
  @{ zp = 0xC2; span = 3; owner = 'key-white' }
  @{ zp = 0xC5; span = 3; owner = 'key-black' }
  @{ zp = 0xC8; span = 3; owner = 'portcullis-states' }
  @{ zp = 0xCB; span = 3; owner = 'bat' }
  @{ zp = 0xCE; span = 3; owner = 'bat-internals' }
)

$layouts = @()
for ($g = 0; $g -lt 3; $g++) {
  $p = (Pk($LAYOUT_PTRS + 2 * $g + 1)) * 256 + (Pk($LAYOUT_PTRS + 2 * $g))
  $placements = @()
  foreach ($s in $slots) {
    $off = $s.zp - $ZP_BASE
    $rec = [ordered]@{ owner = $s.owner; zp = Hex $s.zp }
    if ($s.owner -eq 'portcullis-states') {
      $rec.goldState  = Hex (Pk($p + $off))
      $rec.whiteState = Hex (Pk($p + $off + 1))
      $rec.blackState = Hex (Pk($p + $off + 2))
    } elseif ($s.owner -eq 'bat-internals') {
      $rec.carrying   = Hex (Pk($p + $off))
      $rec.flapPhase  = Hex (Pk($p + $off + 1))
      $rec.chaseTimer = Hex (Pk($p + $off + 2))
    } else {
      $rec.room = Hex (Pk($p + $off))
      $rec.x    = Hex (Pk($p + $off + 1))
      $rec.y    = Hex (Pk($p + $off + 2))
      if ($s.span -eq 5) { $rec.state = Hex (Pk($p + $off + 4)) }
    }
    $placements += $rec
  }
  $layouts += [ordered]@{ game = $g + 1; tableAddr = Hex $p 4; placements = $placements }
}

$randomised = @()
for ($y = 0; $y -le 0x1E; $y += 3) {
  $zp = Pk($RANDOM_TBL + $y)
  $owner = ($slots | Where-Object { $_.zp -eq $zp }).owner
  $randomised += [ordered]@{ owner = $owner; zp = Hex $zp; minRoom = Hex (Pk($RANDOM_TBL + $y + 1)); maxRoom = Hex (Pk($RANDOM_TBL + $y + 2)) }
}

# ---------------------------------------------------------------- behaviour --
# Each list is a 00-terminated run of {a,b} zero-page address pairs. The engine
# walks toward b from a. So when the creature is the FIRST member it chases the
# other object; when it is the SECOND member it flees. Nothing else encodes it.
function OwnerOf([int]$zp) {
  if ($zp -eq 0x8A) { return 'player' }
  $o = ($slots | Where-Object { $_.zp -eq $zp }).owner
  if ($o) { return $o } else { return ('zp-' + (Hex $zp)) }
}
function PairList([int]$addr, [int]$selfZp) {
  $out = @(); $i = 0
  while ((Pk($addr + $i)) -ne 0 -and $i -lt 64) {
    $a = Pk($addr + $i); $b = Pk($addr + $i + 1)
    $rec = [ordered]@{ first = OwnerOf $a; second = OwnerOf $b }
    if ($selfZp -ne 0) {
      if ($a -eq $selfZp) { $rec.mode = 'chase'; $rec.target = OwnerOf $b }
      else                { $rec.mode = 'flee';  $rec.target = OwnerOf $a }
    }
    $out += $rec
    $i += 2
  }
  return $out
}

$behaviour = [ordered]@{
  # stepsPerFrame comes from the LDY immediate fed to the mover at $F5FF.
  playerStepsPerFrame = 3
  dragons = @(
    [ordered]@{ name = 'dragon-rhindle'; zp = 'A4'; listAddr = 'F7A7'; stepsPerFrame = 3; rules = (PairList 0xF7A7 0xA4) }
    [ordered]@{ name = 'dragon-yorgle';  zp = 'A9'; listAddr = 'F7C2'; stepsPerFrame = 2; rules = (PairList 0xF7C2 0xA9) }
    [ordered]@{ name = 'dragon-grundle'; zp = 'AE'; listAddr = 'F7DD'; stepsPerFrame = 2; rules = (PairList 0xF7DD 0xAE) }
  )
  # Bite wind-up: state is seeded from $F89F[difficultyP0 | gameNumber] and
  # counts up to $FC, at which point the dragon swallows. Lower = slower bite.
  dragonBiteSeed = [ordered]@{
    tableAddr = 'F89F'
    game1 = [ordered]@{ difficultyB = Hex (Pk 0xF89F); difficultyA = Hex (Pk 0xF8A0) }
    game2 = [ordered]@{ difficultyB = Hex (Pk 0xF8A1); difficultyA = Hex (Pk 0xF8A2) }
    game3 = [ordered]@{ difficultyB = Hex (Pk 0xF8A3); difficultyA = Hex (Pk 0xF8A4) }
  }
  bat     = [ordered]@{ listAddr = 'F927'; priority = (PairList 0xF927 0xCB) }
  magnet  = [ordered]@{ listAddr = 'F9DA'; attracts = (PairList 0xF9DA 0) }
  castles = @(
    [ordered]@{ castle = 'gold';  exteriorRoom = '11'; interiorRoom = '12'; gate = 'portcullis-gold';  key = 'key-gold' }
    [ordered]@{ castle = 'white'; exteriorRoom = '0F'; interiorRoom = '1A'; gate = 'portcullis-white'; key = 'key-white' }
    [ordered]@{ castle = 'black'; exteriorRoom = '10'; interiorRoom = '1B'; gate = 'portcullis-black'; key = 'key-black' }
  )
  variantExits = @()
}
for ($i = 0; $i -lt 6; $i++) {
  $behaviour.variantExits += [ordered]@{
    exitCode = Hex (0x80 + 3 * $i)
    game1    = Hex (Pk($VAREXIT_TBL + 3 * $i))
    game2    = Hex (Pk($VAREXIT_TBL + 3 * $i + 1))
    game3    = Hex (Pk($VAREXIT_TBL + 3 * $i + 2))
  }
}

# -------------------------------------------------------------------- emit --
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$src = [ordered]@{ rom = (Split-Path $RomPath -Leaf); md5 = (Get-FileHash $RomPath -Algorithm MD5).Hash; generatedBy = 'tools/decode-rom.ps1' }

@{ source = $src; roomTableBase = 'FE1B'; stride = 9; rooms = $rooms } |
  ConvertTo-Json -Depth 8 | Set-Content "$OutDir\rooms.json" -Encoding utf8
@{ source = $src; objectTableBase = 'FF44'; stride = 9; objects = $objects } |
  ConvertTo-Json -Depth 8 | Set-Content "$OutDir\objects.json" -Encoding utf8
@{ source = $src; zeroPageBase = 'A1'; slots = $slots; layouts = $layouts; game3Randomised = $randomised } |
  ConvertTo-Json -Depth 8 | Set-Content "$OutDir\layouts.json" -Encoding utf8
@{ source = $src; behaviour = $behaviour } |
  ConvertTo-Json -Depth 8 | Set-Content "$OutDir\behaviour.json" -Encoding utf8

Write-Output "wrote rooms.json objects.json layouts.json behaviour.json -> $OutDir"

if ($Bitmaps) {
  Write-Output ''
  foreach ($r in $rooms) {
    Write-Output ("room {0} {1}" -f $r.id, $r.name)
    foreach ($row in $r.walls) { Write-Output ('  |' + $row + '|') }
  }
  foreach ($o in $objects) {
    Write-Output ("object {0} {1}" -f $o.code, $o.name)
    foreach ($f in $o.frames) {
      Write-Output ("  frame maxState={0} h={1}" -f $f.maxState, $f.height)
      $gp = [Convert]::ToInt32($f.gfxAddr, 16)
      for ($i = 0; $i -lt $f.height; $i++) {
        $bv = Pk($gp + $i); $s = ''
        for ($b = 7; $b -ge 0; $b--) { $s += $(if ($bv -band (1 -shl $b)) { '#' } else { '.' }) }
        Write-Output ('    ' + $s)
      }
    }
  }
}

