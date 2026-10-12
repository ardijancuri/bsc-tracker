"""Construct clean optical geometry as native SVG paths."""
from pathlib import Path
import math
import numpy as np

folder = Path(__file__).resolve().parent
center = np.array([64.0, 64.0])
radius = 49.0
def polar(angle, r):
    a = math.radians(angle)
    return center + np.array([math.cos(a), math.sin(a)]) * r
def unit(v):
    return v / np.linalg.norm(v)
def inset_line(a, b, inset=1.7):
    direction = b-a
    normal = unit(np.array([-direction[1], direction[0]]))
    return a+normal*inset, direction
def intersection(a, u, b, v):
    t, _ = np.linalg.solve(np.column_stack([u,-v]),b-a)
    return a+t*u
def circle_intersection(p, v, near):
    z=p-center
    roots=np.roots([np.dot(v,v),2*np.dot(z,v),np.dot(z,z)-radius*radius])
    candidates=[p+float(t)*v for t in roots]
    return min(candidates,key=lambda q:np.linalg.norm(q-near))
def xy(p):
    return f'{p[0]:.3f} {p[1]:.3f}'

a0=polar(-90,radius)
b0=polar(-30,radius)
c0=polar(30,23.094)
d0=polar(-30,23.094)
bc, vbc=inset_line(b0,c0)
cd, vcd=inset_line(c0,d0)
da, vda=inset_line(d0,a0)
a=circle_intersection(da,vda,a0)
b=circle_intersection(bc,vbc,b0)
c=intersection(bc,vbc,cd,vcd)
d=intersection(cd,vcd,da,vda)
corner=2.0
a_inner=a+unit(d-a)*corner
b_inner=b+unit(c-b)*corner
c_in=c+unit(b-c)*corner
c_out=c+unit(d-c)*corner
d_in=d+unit(c-d)*corner
d_out=d+unit(a-d)*corner
a_angle=math.degrees(math.atan2(*(a-center)[::-1]))
b_angle=math.degrees(math.atan2(*(b-center)[::-1]))
a_rim=polar(a_angle+math.degrees(corner/radius),radius)
b_rim=polar(b_angle-math.degrees(corner/radius),radius)
blade=f'M {xy(a_inner)} Q {xy(a)} {xy(a_rim)} A {radius} {radius} 0 0 1 {xy(b_rim)} Q {xy(b)} {xy(b_inner)} L {xy(c_in)} Q {xy(c)} {xy(c_out)} L {xy(d_in)} Q {xy(d)} {xy(d_out)} Z'
iris='\n'.join(f'    <path d="{blade}" transform="rotate({i*60} 64 64)"/>' for i in range(6))
def save(stem,title,inner):
    svg=f'<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-labelledby="title">\n  <title id="title">Kollens {title} icon</title>\n{inner}\n</svg>\n'
    (folder/f'{stem}.svg').write_text(svg,encoding='utf-8')
save('43-geometric-shutter','geometric shutter',f'  <g fill="#f9c932">\n{iris}\n  </g>')
save('44-open-k-optic','open K optic','''  <path d="M70 45 L98 30 A48 48 0 1 0 98 98 L70 83" fill="none" stroke="#f9c932" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="64" cy="64" r="6.5" fill="#f9c932"/>''')
save('45-focus-shutter','focus shutter',f'''  <g fill="none" stroke="#f9c932" stroke-width="12" stroke-linecap="round" stroke-linejoin="round">
    <path d="M42 17 H35 Q17 17 17 35 V42"/>
    <path d="M86 17 H93 Q111 17 111 35 V42"/>
    <path d="M17 86 V93 Q17 111 35 111 H42"/>
    <path d="M111 86 V93 Q111 111 93 111 H86"/>
  </g>
  <g fill="#f9c932" transform="translate(64 64) scale(0.53) translate(-64 -64)">
{iris}
  </g>''')
print('Created three icons with circular arcs, matching blade joints and controlled spacing.')
