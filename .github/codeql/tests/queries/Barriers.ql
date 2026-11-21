/** Every node the encodeRow barrier covers in the fixtures, as an exact list. */
import javascript
import EncodeRowBarrier

from EncodeRowResult b
select b.getFile().getRelativePath(), b.getLocation().getStartLine(), b.toString()
