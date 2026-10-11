from odoo import models, fields, api


class SamPosProduct(models.Model):
    _name = 'sam.pos.product'
    _description = "Sam's Hotel POS Product"
    _inherits = {'product.product': 'product_tmpl_id'}
    _order = 'sequence, name'

    product_tmpl_id = fields.Many2one(
        'product.product', required=True, ondelete='cascade'
    )
    sequence = fields.Integer(default=10)
    category_id = fields.Many2one('sam.pos.category', string='POS Category', required=True)
    department = fields.Selection(related='category_id.department', store=True)
    unit_label = fields.Char(default='plate', help="e.g. plate, cup, piece")
    weight_grams = fields.Float(string='Weight (g)')
    is_available = fields.Boolean(default=True)

    def name_get(self):
        return [(p.id, f"{p.name} ({p.unit_label})") for p in self]
