from odoo import models, fields, api


class SamPosCategory(models.Model):
    _name = 'sam.pos.category'
    _description = "Sam's Hotel POS Category"
    _order = 'sequence, name'

    name = fields.Char(string='Category Name', required=True, translate=True)
    sequence = fields.Integer(default=10)
    color = fields.Char(default='#1E6FD9', help="Hex color for the category card")
    icon = fields.Char(help="Emoji or icon class")
    department = fields.Selection([
        ('food', 'Food'),
        ('beverage', 'Beverages'),
        ('equipment', 'Equipment'),
    ], string='Department', required=True, default='food')

    product_ids = fields.One2many('sam.pos.product', 'category_id', string='Products')
    product_count = fields.Integer(compute='_compute_product_count')

    @api.depends('product_ids')
    def _compute_product_count(self):
        for rec in self:
            rec.product_count = len(rec.product_ids)
